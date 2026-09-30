 /**
 * 333 Watcher - Offscreen Document (v0.6.34)
 *
 * Service Worker 无 DOM，这里负责：
 * DOMParser 解析页面 HTML + querySelector 定位元素，返回属性值。
 */

const MAX_HTML_BYTES = 2.5 * 1024 * 1024;
const MAX_SCAN_NODES = 50000;

function utf8Bytes(str) { return new TextEncoder().encode(str).length; }
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(String(value));
  // 回退实现要自己处理前导数字：id 为 `123abc` 时裸写 `#123abc` 是非法选择器，
  // offscreen 侧 querySelector 会抛错，整次元素读取失败。用十六进制转义处理
  // 首字符（\31 <space> 表示 '1'），语义与原生 CSS.escape 一致。
  const escaped = String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  return escaped.replace(/^(-?)(\d)/, (_m, dash, digit) => dash + '\\3' + digit + ' ');
}
function quoteAttr(value) {
  return JSON.stringify(String(value));
}
function assertHtmlSize(html) {
  if (typeof html !== 'string') throw new Error('html is missing');
  if (utf8Bytes(html) > MAX_HTML_BYTES) throw new Error('html too large');
}

// 从 href 里取出"扩展名 + 稳定词干"，用作下载链接的属性选择器。
// 只靠 `a[href$=".exe"]` 在多下载项页面（多版本、多架构、不同产品）永远命中
// 第一个 a，监控会盯错链接；但写死完整文件名又会在版本升级改名后直接失效。
// 因此：扩展名保底（版本号变化不影响）+ 文件名词干做区分（同产品的不同版本都命中，
// 不同产品/架构不会互相串）。返回 null 表示区分度不足，退回宽松选择器。
function downloadSelectorParts(href) {
  const raw = String(href || '');
  // 去掉查询串/片段：签名链接的 token 每次都变，绝不能进选择器。
  const path = raw.split(/[?#]/)[0];
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const stem = base.slice(0, dot);
  // 去掉末尾版本号：WeChatSetup_4.0.6.19 -> WeChatSetup，v2 -> ""。
  const hint = stem.replace(/[._-]?v?\d+(?:[._-]\w+)*$/i, '');
  // 至少 3 个字母才算有区分度：a.exe / 1.exe / ab12.exe 这类只加噪音。
  if ((hint.match(/[a-z]/gi) || []).length < 3) return null;
  // 用原始（未解码）词干：percent-encoded 的 href 里字面量必须对得上，
  // 否则选择器会匹配不到任何元素。
  return { ext: base.slice(dot), hint };
}

function buildSelector(el) {
  // 微信下载页等 a 标签优先返回稳定的属性选择器
  if (el.tagName === 'A' || (el.getAttribute && el.getAttribute('href') && el.getAttribute('href').includes('wechat_devtools'))) {
    const h = el.getAttribute('href')||'';
    if (h.includes('wechat_devtools')) return 'a[href*=' + quoteAttr('wechat_devtools') + ']';
    // 下载链接必须带上区分标记，否则多下载项页面永远命中第一个 a：
    // 自愈把别的链接当成目标，既立刻误报一次"已变化"，真目标后续怎么变都发现不了。
    const parts = downloadSelectorParts(h);
    if (parts) {
      return 'a[href$=' + quoteAttr(parts.ext) + '][href*=' + quoteAttr(parts.hint) + ']';
    }
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

