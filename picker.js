/**
 * 333 Watcher - 元素选择器 Content Script
 *
 * 由 popup 通过 chrome.scripting.executeScript 注入。
 * 选择模式：
 * - 鼠标移动：蓝色边框高亮当前元素 + 标签名提示
 * - 点击：捕获元素信息，并在页面内弹出保存浮层
 * - Esc：退出选择模式
 *
 * 浮层内可直接选择监控类型并保存，无需再次打开扩展 popup。
 */
(function () {
  // 允许重复点击「选择网页元素」：若已激活则先清理再重启
  if (window.__w333PickerActive) {
    try { window.__w333PickerCleanup && window.__w333PickerCleanup(); } catch {}
    try {
      document.querySelectorAll('div').forEach(d=>{ if(d.style && d.style.zIndex==='2147483646') d.remove(); });
    } catch {}
  }
  window.__w333PickerActive = true;
  const DEBUG = false;
  function dbg(...args) { if (DEBUG) console.log(...args); }

  let dialogHost = null;
  let pickResult = null;

  // 高亮框
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483646;' +
    'border:2px solid #2f81f7;background:rgba(47,129,247,0.12);' +
    'border-radius:2px;display:none;';

  // 标签名提示
  const tip = document.createElement('div');
  tip.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483646;' +
    'background:#1f6feb;color:#ffffff;font:12px/1.5 sans-serif;' +
    'padding:2px 8px;border-radius:4px;display:none;';

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(tip);

  // 生成 CSS selector：优先 #id / 特征属性，否则 tag + :nth-of-type 路径
  function getSelector(el) {
    // 1) a 标签优先用可自愈的属性选择器，避免 nth-of-type 脆弱链
    if (el.tagName === 'A' || el.closest('a')) {
      const a = el.closest('a') || el;
      const href = a.getAttribute('href') || '';
      if (href.includes('wechat_devtools')) return 'a[href*=''wechat_devtools'']';
      if (href.endsWith('.exe')) return 'a[href$=''.exe'']';
      if (href) {
        try {
          const u = new URL(a.href);
          if (u.hostname.includes('wxqcloud')) return 'a[href*=''wxqcloud'']';
        } catch {}
      }
    }
    // 2) 有稳定 id 直接用
    if (el.id) return '#' + CSS.escape(el.id);
    // 3) 尝试用 data-* 或 class 构成更稳的路径
    if (el.getAttribute && el.getAttribute('data-testid')) {
      return el.tagName.toLowerCase() + '[data-testid=''' + CSS.escape(el.getAttribute('data-testid')) + ''']';
    }
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
    // 兜底：给超长 nth-of-type 链追加文本锚点提示，仍返回路径
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

  function elementText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  function defaultAttribute(el) {
    if (el.closest('a')) return 'href';
    if (el.tagName === 'IMG') return 'src';
    return 'text';
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    const closestLink = el.closest('a');
    const href = closestLink ? closestLink.href : (el.href || '');

    pickResult = {
      tagName: el.tagName.toLowerCase(),
      text: elementText(el),
      href: href,
      src: el.currentSrc || el.src || '',
      selector: getSelector(el),
      attribute: defaultAttribute(el),
      pageUrl: location.href,
      pageTitle: document.title,
      pickedAt: new Date().toISOString()
    };

    stopPickMode();
    chrome.storage.sync.set({ pendingPick: pickResult }).then(showDialog).catch(() => showDialog());
  }

  function stopPickMode() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    overlay.style.display = 'none';
    tip.style.display = 'none';
  }

  function startPickMode() {
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
  }

  function attributeLabel(attr) {
    if (attr === 'href') return '链接地址';
    if (attr === 'src') return '图片地址';
    return '文字内容';
  }

  function attributeValue(pick, attr) {
    if (attr === 'href') return pick.href || '';
    if (attr === 'src') return pick.src || '';
    return pick.text || '';
  }

  // ---- 页面内保存浮层 ----
  const DIALOG_CSS =
    '.w333-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(3,9,18,0.62);font-family:"Segoe UI",system-ui,-apple-system,sans-serif;}' +
    '.w333-card{width:330px;max-width:calc(100vw - 32px);background:#0d1626;border:1px solid #24405f;' +
    'border-radius:8px;padding:16px;color:#e6edf6;box-shadow:0 14px 44px rgba(0,0,0,0.55);box-sizing:border-box;}' +
    '.w333-head{font-size:12px;color:#8fb4e8;margin-bottom:6px;}' +
    '.w333-element{font-size:13px;color:#ffffff;background:#0a111f;border:1px solid #1f3a5c;border-radius:6px;' +
    'padding:8px 10px;margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.4;}' +
    '.w333-label{font-size:12px;color:#8fb4e8;margin-bottom:8px;}' +
    '.w333-options{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;}' +
    '.w333-option{display:flex;align-items:center;gap:8px;font-size:13px;color:#dbe6f3;cursor:pointer;}' +
    '.w333-option input{accent-color:#2f81f7;}' +
    '.w333-actions{display:flex;gap:8px;}' +
    '.w333-btn{flex:1;height:34px;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-family:inherit;}' +
    '.w333-primary{background:#1f6feb;color:#ffffff;}' +
    '.w333-primary:hover{background:#2f81f7;}' +
    '.w333-primary:disabled{opacity:0.6;cursor:default;}' +
    '.w333-ghost{background:transparent;color:#9db8d6;border:1px solid #2b4a6e;}' +
    '.w333-ghost:hover{background:#12233a;}' +
    '.w333-msg{min-height:16px;margin-top:10px;font-size:12px;color:#7dd3a8;line-height:1.4;}' +
    '.w333-msg.error{color:#f08a8a;}';

  const TOAST_CSS =
    '.w333-toast{background:#0f2338;color:#ffffff;border:1px solid #2f81f7;border-radius:6px;' +
    'padding:10px 16px;font:13px/1.4 "Segoe UI",system-ui,sans-serif;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.45);white-space:nowrap;}';

  function showDialog() {
    if (!pickResult) return;
    if (dialogHost) dialogHost.remove();

    dialogHost = document.createElement('div');
    dialogHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const shadow = dialogHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = DIALOG_CSS;
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'w333-backdrop';

    const card = document.createElement('div');
    card.className = 'w333-card';

    const head = document.createElement('div');
    head.className = 'w333-head';
    head.textContent = '已选择元素';

    const elBox = document.createElement('div');
    elBox.className = 'w333-element';
    const attr = ['href', 'src'].includes(pickResult.attribute) ? pickResult.attribute : 'text';
    const sample = attributeValue(pickResult, attr);
    elBox.textContent = pickResult.tagName + ' · ' + attributeLabel(attr) +
      (sample ? ' · ' + sample.slice(0, 40) : '');
    elBox.title = pickResult.selector || '';

    const typeLabel = document.createElement('div');
    typeLabel.className = 'w333-label';
    typeLabel.textContent = '选择监控类型';

    const options = document.createElement('div');
    options.className = 'w333-options';
    const choices = [
      ['text', '文字变化'],
      ['href', '链接地址变化'],
      ['src', '图片地址变化']
    ];
    for (const [value, text] of choices) {
      const lab = document.createElement('label');
      lab.className = 'w333-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'w333-attr';
      input.value = value;
      input.checked = attr === value;
      const span = document.createElement('span');
      span.textContent = text;
      lab.appendChild(input);
      lab.appendChild(span);
      options.appendChild(lab);
    }

    const actions = document.createElement('div');
    actions.className = 'w333-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'w333-btn w333-primary';
    saveBtn.textContent = '保存监控';
    const reselectBtn = document.createElement('button');
    reselectBtn.type = 'button';
    reselectBtn.className = 'w333-btn w333-ghost';
    reselectBtn.textContent = '重新选择';
    actions.appendChild(saveBtn);
    actions.appendChild(reselectBtn);

    const msg = document.createElement('div');
    msg.className = 'w333-msg';

    card.appendChild(head);
    card.appendChild(elBox);
    card.appendChild(typeLabel);
    card.appendChild(options);
    card.appendChild(actions);
    card.appendChild(msg);
    backdrop.appendChild(card);
    shadow.appendChild(backdrop);
    document.documentElement.appendChild(dialogHost);

    saveBtn.addEventListener('click', () => savePicked(saveBtn, msg));
    reselectBtn.addEventListener('click', () => {
      if (dialogHost) dialogHost.remove();
      dialogHost = null;
      startPickMode();
    });
  }

  async function savePicked(saveBtn, msgEl) {
    if (!pickResult) return;
    const checked = dialogHost && dialogHost.shadowRoot &&
      dialogHost.shadowRoot.querySelector('input[name="w333-attr"]:checked');
    const attribute = checked ? checked.value : 'text';

    saveBtn.disabled = true;
    msgEl.textContent = '';
    msgEl.classList.remove('error');

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'save-element-monitor',
        pick: pickResult,
        attribute: attribute
      });
      if (res && res.ok) {
        try { await chrome.storage.sync.remove('pendingPick'); } catch (e) {}
        showToast(res.mode === 'updated' ? '已更新监控' : '已添加监控');
        cleanup();
      } else {
        msgEl.textContent = (res && res.error) || '保存失败，请重试';
        msgEl.classList.add('error');
        saveBtn.disabled = false;
      }
    } catch (err) {
      console.error('[333 Watcher] save picked monitor failed:', err);
      msgEl.textContent = '保存失败：' + (err.message || '未知错误');
      msgEl.classList.add('error');
      saveBtn.disabled = false;
    }
  }

  function showToast(text) {
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    const box = document.createElement('div');
    box.className = 'w333-toast';
    box.textContent = text;
    shadow.appendChild(style);
    shadow.appendChild(box);
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 2400);
  }

  function onKey(e) {
    if (e.key === 'Escape') cleanup();
  }

  window.__w333PickerCleanup = cleanup;
  function cleanup() {
    stopPickMode();
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    tip.remove();
    if (dialogHost) {
      dialogHost.remove();
      dialogHost = null;
    }
    pickResult = null;
    window.__w333PickerActive = false;
  }

  // popup 保存成功后，通知页面关闭浮层
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'w333-close-dialog') cleanup();
  });

  startPickMode();
  document.addEventListener('keydown', onKey, true);
  // 激活提示，避免用户以为没反应
  showToast('已进入选择模式：鼠标移动高亮，点击选中，Esc 退出');
  dbg('[333 Watcher] picker activated');
})();