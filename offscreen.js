/**
 * 333 Watcher - Offscreen Document
 *
 * Service Worker 无 DOM，这里负责：
 * DOMParser 解析页面 HTML + querySelector 定位元素，返回属性值。
 */

// 生成 CSS selector：优先 #id，否则 tag + :nth-of-type 路径（与 picker.js 一致）
function buildSelector(el) {
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
      const anchors = doc.querySelectorAll('a[href]');
      for (const a of anchors) {
        let abs;
        try {
          abs = new URL(a.getAttribute('href'), msg.baseUrl).href;
        } catch { continue; }
        if (abs === msg.value) {
          sendResponse({ ok: true, selector: buildSelector(a) });
          return true;
        }
      }
      sendResponse({ ok: false, error: 'no matching anchor' });
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
    if (msg.attribute === 'href') {
      value = el.getAttribute('href') || '';
    } else {
      value = (el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    sendResponse({ ok: true, value: value });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
  return true;
});
