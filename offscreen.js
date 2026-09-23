 /**
 * 333 Watcher - Offscreen Document (v0.6.20)
 *
 * Service Worker 无 DOM，这里负责：
 * DOMParser 解析页面 HTML + querySelector 定位元素，返回属性值。
 */

const MAX_HTML_BYTES = 2.5 * 1024 * 1024;
const MAX_SCAN_NODES = 50000;

function utf8Bytes(str) { return new TextEncoder().encode(str).length; }
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
}
function quoteAttr(value) {
  return JSON.stringify(String(value));
}
function assertHtmlSize(html) {
  if (typeof html !== 'string') throw new Error('html is missing');
  if (utf8Bytes(html) > MAX_HTML_BYTES) throw new Error('html too large');
}

function buildSelector(el) {
  // 微信下载页等 a 标签优先 returning robust attribute selector
  if (el.tagName === 'A' || (el.getAttribute && el.getAttribute('href') && el.getAttribute('href').includes('wechat_devtools'))) {
    const h = el.getAttribute('href')||'';
    if (h.includes('wechat_devtools')) return 'a[href*=' + quoteAttr('wechat_devtools') + ']';
    if (h.endsWith('.exe')) return 'a[href$=' + quoteAttr('.exe') + ']';
  }
  if (el.id) return '#' + cssEscape(el.id);
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift('#' + cssEscape(node.id));
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === node.tagName
      );
      if (sameTag.length > 1) {
        part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'find-by-value') {
    try {
      assertHtmlSize(msg.html);
      const doc = new DOMParser().parseFromString(msg.html, 'text/html');
      const attr = msg.attribute || 'href';
      const target = (msg.value || '').trim();
      if (!target) { sendResponse({ ok: false, error: 'empty value' }); return true; }

      if (attr === 'href') {
        const anchors = doc.querySelectorAll('a[href]');
        for (const a of anchors) {
          let abs;
          try { abs = new URL(a.getAttribute('href'), msg.baseUrl).href; } catch { continue; }
          if (abs === target) { sendResponse({ ok: true, selector: buildSelector(a) }); return true; }
        }
      } else if (attr === 'src') {
        const medias = doc.querySelectorAll('[src]');
        for (const el of medias) {
          let abs;
          try { abs = new URL(el.getAttribute('src'), msg.baseUrl).href; } catch { abs = el.getAttribute('src') || ''; }
          if (abs === target || (el.getAttribute('src')||'') === target) { sendResponse({ ok: true, selector: buildSelector(el) }); return true; }
        }
      } else {
        // text: 优先返回最深的匹配节点，避免 body/父容器抢占真实目标。
        const all = doc.querySelectorAll('*');
        let exactFallback = null;
        let scanned = 0;
        for (const el of all) {
          if (scanned++ >= MAX_SCAN_NODES) break;
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t === target) {
            if (el.children.length === 0) { sendResponse({ ok: true, selector: buildSelector(el) }); return true; }
            if (!exactFallback) exactFallback = el;
          }
          // 模糊匹配只接受叶子节点，避免把整页/卡片文本误判为目标。
          if (!exactFallback && t && target.length < 80 && t.includes(target) && el.children.length === 0) {
            sendResponse({ ok: true, selector: buildSelector(el) }); return true;
          }
        }
        if (exactFallback) { sendResponse({ ok: true, selector: buildSelector(exactFallback) }); return true; }
        if (scanned >= MAX_SCAN_NODES) { sendResponse({ ok: false, error: 'DOM scan limit reached' }); return true; }
      }
      sendResponse({ ok: false, error: 'no matching element for ' + attr });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }
  if (msg.type !== 'query-element') return;

  try {
    assertHtmlSize(msg.html);
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    const el = doc.querySelector(msg.selector);
    if (!el) {
      sendResponse({ ok: false, error: 'element not found: ' + msg.selector });
      return true;
    }
    let value;
    if (msg.attribute === 'href') value = el.getAttribute('href') || '';
    else if (msg.attribute === 'src') value = el.getAttribute('src') || '';
    else value = (el.textContent || '').replace(/\s+/g, ' ').trim();
    sendResponse({ ok: true, value: value });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
  return true;
});

