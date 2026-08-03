/**
 * 333 Watcher - 元素选择器 Content Script
 *
 * 由 popup 通过 chrome.scripting.executeScript 注入。
 * 进入选择模式：
 * - 鼠标移动：蓝色边框高亮当前元素 + 标签名提示
 * - 点击：捕获元素信息（tagName / text / href / CSS selector）
 * - Esc：退出选择模式
 *
 * 结果存入 chrome.storage.sync.pendingPick，并通知 background 提示用户。
 */
(function () {
  if (window.__w333PickerActive) return;
  window.__w333PickerActive = true;
  const DEBUG = false;
  function dbg(...args) { if (DEBUG) console.log(...args); }

  // 高亮框
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;' +
    'border:2px solid #2f81f7;background:rgba(47,129,247,0.12);' +
    'border-radius:2px;display:none;';

  // 标签名提示
  const tip = document.createElement('div');
  tip.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;' +
    'background:#1f6feb;color:#ffffff;font:12px/1.5 sans-serif;' +
    'padding:2px 8px;border-radius:4px;display:none;';

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(tip);

  // 生成 CSS selector：优先 #id，否则 tag + :nth-of-type 路径
  function getSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
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

  function onMove(e) {
    const el = e.target;
    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    tip.style.display = 'block';
    tip.textContent = el.tagName.toLowerCase();
    tip.style.left = r.left + 'px';
    tip.style.top = Math.max(0, r.top - 24) + 'px';
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    const closestLink = el.closest('a');
    const attribute = (el.tagName === 'A' || closestLink) ? 'href' : 'text';
    const href = closestLink ? closestLink.href : (el.href || '');

    const result = {
      tagName: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      href: href,
      selector: getSelector(el),
      attribute: attribute,
      pageUrl: location.href,
      pageTitle: document.title,
      pickedAt: new Date().toISOString()
    };

    chrome.storage.sync.set({ pendingPick: result }).then(() => {
      chrome.runtime.sendMessage({ type: 'element-picked' });
      cleanup();
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') cleanup();
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    tip.remove();
    window.__w333PickerActive = false;
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  dbg('[333 Watcher] picker activated');
})();

