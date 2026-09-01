 /**
 * 333 Watcher - Offscreen Document (v0.6.1)
 *
 * Service Worker 无 DOM，这里负责：
 * DOMParser 解析页面 HTML + querySelector 定位元素，返回属性值。
 */

function buildSelector(el) {
  // 微信下载页等 a 标签优先 returning robust attribute selector
  if (el.tagName === 'A' || (el.getAttribute && el.getAttribute('href') && el.getAttribute('href').includes('wechat_devtools'))) {
    const h = el.getAttribute('href')||'';
    if (h.includes('wechat_devtools')) return 'a[href*="wechat_devtools"]';
    if (h.endsWith('.exe')) return 'a[href$=".exe"]';
  }
  if (el.id) return '#' + el.id;
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift('#' + node.id);
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
        // text: 遍历所有元素，查找 textContent 匹配（规范化空格后相等）
        const all = doc.querySelectorAll('*');
        for (const el of all) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t === target) { sendResponse({ ok: true, selector: buildSelector(el) }); return true; }
          // 模糊：包含匹配（长度<100时）且为叶子节点
          if (t && target.length < 80 && t.includes(target) && el.children.length === 0) {
            sendResponse({ ok: true, selector: buildSelector(el) }); return true;
          }
        }
      }
      sendResponse({ ok: false, error: 'no matching element for ' + attr });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }
  if (msg.type !== 'query-element') return;

  try {
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

