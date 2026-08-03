/**
 * 333 Watcher - Offscreen Document
 *
 * Service Worker 无 DOM，这里负责：
 * DOMParser 解析页面 HTML + querySelector 定位元素，返回属性值。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'query-element') return;

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
