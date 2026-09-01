/**
 * 333 Watcher - 元素选择器 Content Script v0.6.15
 * 修复：微信文档等 Vue 页面选不到的问题
 */
(function () {
  if (window.__w333PickerActive) {
    try { window.__w333PickerCleanup && window.__w333PickerCleanup(); } catch(e) {}
    try { document.querySelectorAll('[data-w333]').forEach(function(n){ n.remove(); }); } catch(e){}
  }
  window.__w333PickerActive = true;

  var dialogHost = null;
  var pickResult = null;
  var lastX = -1, lastY = -1, pollTimer = null, badge = null;

  var overlay = document.createElement('div');
  overlay.setAttribute('data-w333','overlay');
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2f81f7;background:rgba(47,129,247,0.14);border-radius:3px;display:none;box-sizing:border-box;';

  var tip = document.createElement('div');
  tip.setAttribute('data-w333','tip');
  tip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#1f6feb;color:#fff;font:12px/1.5 sans-serif;padding:2px 8px;border-radius:4px;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  badge = document.createElement('div');
  badge.setAttribute('data-w333','badge');
  badge.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483647;background:#0f2338;color:#fff;border:1px solid #2f81f7;border-radius:999px;padding:6px 14px;font:12px/1.4 sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.35);pointer-events:none;';
  badge.textContent = '🎯 选择模式：移动高亮 · 点击选中 · Esc 退出';

  function appendSafe(node){
    try { (document.body || document.documentElement).appendChild(node); return true; } catch(e){ try{ document.documentElement.appendChild(node); return true; } catch(e2){ return false; } }
  }
  appendSafe(overlay);
  appendSafe(tip);
  appendSafe(badge);
  console.log('[333 Watcher] picker overlay injected v0.6.6', overlay, tip, badge, location.href);

  function getSelector(el) {
    if (!el || !el.tagName) return 'body';
    if (el.tagName === 'A' || (el.closest && el.closest('a'))) {
      var a = (el.closest && el.closest('a')) || el;
      var href = (a.getAttribute && a.getAttribute('href')) || '';
      if (href.indexOf('wechat_devtools') !== -1) return 'a[href*=\ wechat_devtools\]';
      if (href.slice(-4) === '.exe') return 'a[href$=\.exe\]';
      if (href) { try { var u = new URL(a.href); if (u.hostname.indexOf('wxqcloud') !== -1) return 'a[href*=\wxqcloud\]'; } catch(e){} }
    }
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute && el.getAttribute('data-testid')) return el.tagName.toLowerCase() + '[data-testid=\ + CSS.escape(el.getAttribute(data-testid)) + \]';
    var parts = []; var node = el;
    while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function(c){ return c.tagName === node.tagName; });
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node)+1) + ')';
      }
      parts.unshift(part);
      node = parent;
      if (parts.length > 8) break;
    }
    return parts.join(' > ');
  }

  function isOwnEl(el){
    if (!el) return false;
    if (el === overlay || el === tip || el === badge) return true;
    if (el.getAttribute && el.getAttribute('data-w333')) return true;
    if (dialogHost && dialogHost.contains(el)) return true;
    var p = el;
    while (p) { if (p.getAttribute && p.getAttribute('data-w333')) return true; if (p === dialogHost) return true; p = p.parentElement; }
    return false;
  }

  function highlight(el){
    if (!el || !el.getBoundingClientRect || isOwnEl(el)) return;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    tip.style.display = 'block';
    var label = el.tagName.toLowerCase();
    if (el.id) label += '#' + el.id;
    else if (el.className && typeof el.className === 'string') {
      var cls = el.className.trim().split(/\s+/).slice(0,2).join('.');
      if (cls) label += '.' + cls;
    }
    var txt = (el.textContent||'').replace(/\s+/g,' ').trim().slice(0,24);
    if (txt) label += ' · ' + txt + ' ';
    tip.textContent = label;
    tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(0, r.left)) + 'px';
    tip.style.top = Math.max(0, r.top - 26) + 'px';
  }

  function resolveTarget(e){
    var el = null;
    if (e.composedPath) { try { var path = e.composedPath(); if (path && path[0]) el = path[0]; } catch(err){} }
    if (!el) el = e.target;
    if (isOwnEl(el)) {
      try {
        overlay.style.display='none'; tip.style.display='none';
        var x = e.clientX, y = e.clientY;
        var under = document.elementFromPoint(x, y);
        overlay.style.display='block';
        if (under && !isOwnEl(under)) el = under; else return null;
      } catch(err){ return null; }
    }
    return el;
  }

  function onMove(e){
    if (e.clientX != null){ lastX = e.clientX; lastY = e.clientY; }
    var el = resolveTarget(e);
    if (!el) return;
    if (el.shadowRoot && e.composedPath) { try{ el = e.composedPath()[0] || el; }catch(_){} }
    highlight(el);
  }

  function pollHighlight(){
    if (lastX < 0) return;
    try {
      overlay.style.display='none'; tip.style.display='none';
      var el = document.elementFromPoint(lastX, lastY);
      overlay.style.display='block';
      if (el && !isOwnEl(el)) highlight(el);
    } catch(e){}
  }

  function elementText(el){
    return (el.textContent||'').replace(/\s+/g,' ').trim().slice(0,120);
  }
  function defaultAttribute(el){
    if (el.closest && el.closest('a')) return 'href';
    if (el.tagName === 'IMG') return 'src';
    return 'text';
  }

  function onClick(e){
    var el = resolveTarget(e);
    if (!el || isOwnEl(el)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation && e.stopImmediatePropagation();
    var closestLink = el.closest ? el.closest('a') : null;
    var href = closestLink ? closestLink.href : (el.href || '');
    pickResult = {
      tagName: el.tagName.toLowerCase(),
      text: elementText(el),
      href: href, src: el.currentSrc || el.src || '',
      selector: getSelector(el), attribute: defaultAttribute(el),
      pageUrl: location.href, pageTitle: document.title, pickedAt: new Date().toISOString()
    };
    console.log('[333 Watcher] picked', pickResult);
    stopPickMode();
    try { chrome.storage.sync.set({ pendingPick: pickResult }).then(function(){ showDialog(); }).catch(function(){ showDialog(); }); } catch(err){ showDialog(); }
  }

  function onKey(e){ if (e.key === 'Escape' || e.key === 'Esc') cleanup(); }

  var listeners = [];
  function addEvt(target, type, handler, cap){
    try { target.addEventListener(type, handler, cap); listeners.push([target,type,handler,cap]); } catch(e){}
  }
  function removeAll(){
    listeners.forEach(function(a){ try{ a[0].removeEventListener(a[1],a[2],a[3]); }catch(e){} });
    listeners=[];
  }

  function stopPickMode(){
    removeAll();
    overlay.style.display='none'; tip.style.display='none';
    if (pollTimer) { clearInterval(pollTimer); pollTimer=null; }
  }
  function startPickMode(){
    var caps = true;
    [document, window, document.documentElement, document.body].forEach(function(t){
      if (!t || !t.addEventListener) return;
      addEvt(t,'pointermove',onMove,caps); addEvt(t,'mousemove',onMove,caps); addEvt(t,'mouseover',onMove,caps); addEvt(t,'click',onClick,caps);
    });
    addEvt(document,'keydown',onKey,true); addEvt(window,'keydown',onKey,true);
    try{ window.focus(); }catch(e){}
    pollTimer = setInterval(pollHighlight, 120);
  }

  function attributeLabel(attr){ if(attr==='href')return'链接地址'; return'文字内容'; }
  function attributeValue(pick,attr){ if(attr==='href')return pick.href||''; return pick.text||''; }

  var DIALOG_CSS='.w333-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(3,9,18,0.62);font-family:\Segoe UI\,system-ui,-apple-system,sans-serif;z-index:2147483647;}'
    +'.w333-card{width:330px;max-width:calc(100vw - 32px);background:#0d1626;border:1px solid #24405f;border-radius:8px;padding:16px;color:#e6edf6;box-shadow:0 14px 44px rgba(0,0,0,0.55);box-sizing:border-box;}'
    +'.w333-head{font-size:12px;color:#8fb4e8;margin-bottom:6px;}.w333-element{font-size:13px;color:#fff;background:#0a111f;border:1px solid #1f3a5c;border-radius:6px;padding:8px 10px;margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.4;}'
    +'.w333-label{font-size:12px;color:#8fb4e8;margin-bottom:8px;}.w333-options{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;}.w333-option{display:flex;align-items:center;gap:8px;font-size:13px;color:#dbe6f3;cursor:pointer;}'
    +'.w333-option input{accent-color:#2f81f7;}.w333-actions{display:flex;gap:8px;}.w333-btn{flex:1;height:34px;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-family:inherit;}'
    +'.w333-primary{background:#1f6feb;color:#fff;}.w333-primary:hover{background:#2f81f7;}.w333-primary:disabled{opacity:0.6;cursor:default;}.w333-ghost{background:transparent;color:#9db8d6;border:1px solid #2b4a6e;}.w333-ghost:hover{background:#12233a;}'
    +'.w333-msg{min-height:16px;margin-top:10px;font-size:12px;color:#7dd3a8;line-height:1.4;}.w333-msg.error{color:#f08a8a;}';
  var TOAST_CSS='.w333-toast{background:#0f2338;color:#fff;border:1px solid #2f81f7;border-radius:6px;padding:10px 16px;font:13px/1.4 \Segoe UI\,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.45);}';

  function showDialog(){
    if (dialogHost) try{ dialogHost.remove(); }catch(e){}
    dialogHost = document.createElement('div'); dialogHost.setAttribute('data-w333','dialog');
    dialogHost.style.cssText='position:fixed;inset:0;z-index:2147483647;';
    var shadow = dialogHost.attachShadow({mode:'open'});
    var style = document.createElement('style'); style.textContent = DIALOG_CSS;
    var backdrop = document.createElement('div'); backdrop.className='w333-backdrop';
    var card = document.createElement('div'); card.className='w333-card';
    var head = document.createElement('div'); head.className='w333-head'; head.textContent='已选择元素';
    var elBox = document.createElement('div'); elBox.className='w333-element';
    var attr = pickResult.attribute === 'href' ? 'href' : 'text';
    var sample = attributeValue(pickResult, attr);
    elBox.textContent = pickResult.tagName + ' · ' + attributeLabel(attr) + (sample ? ' · ' + sample.slice(0,40) : ''); elBox.title = pickResult.selector||'';
    var typeLabel = document.createElement('div'); typeLabel.className='w333-label'; typeLabel.textContent='选择监控类型';
    var options = document.createElement('div'); options.className='w333-options';
    [['text','文字变化'],['href','链接地址变化']].forEach(function(pair){
      var lab=document.createElement('label'); lab.className='w333-option';
      var input=document.createElement('input'); input.type='radio'; input.name='w333-attr'; input.value=pair[0]; input.checked=(attr===pair[0]);
      var span=document.createElement('span'); span.textContent=pair[1]; lab.appendChild(input); lab.appendChild(span); options.appendChild(lab);
    });
    var actions=document.createElement('div'); actions.className='w333-actions';
    var saveBtn=document.createElement('button'); saveBtn.type='button'; saveBtn.className='w333-btn w333-primary'; saveBtn.textContent='保存监控';
    var reselectBtn=document.createElement('button'); reselectBtn.type='button'; reselectBtn.className='w333-btn w333-ghost'; reselectBtn.textContent='重新选择';
    actions.appendChild(saveBtn); actions.appendChild(reselectBtn);
    var msg=document.createElement('div'); msg.className='w333-msg';
    card.appendChild(head); card.appendChild(elBox); card.appendChild(typeLabel); card.appendChild(options); card.appendChild(actions); card.appendChild(msg);
    backdrop.appendChild(card); shadow.appendChild(style); shadow.appendChild(backdrop);
    appendSafe(dialogHost);
    saveBtn.addEventListener('click', function(){ savePicked(saveBtn, msg); });
    reselectBtn.addEventListener('click', function(){ if(dialogHost) dialogHost.remove(); dialogHost=null; startPickMode(); if(badge) badge.style.display='block'; });
    if(badge) badge.style.display='none';
  }

  function savePicked(saveBtn, msgEl){
    if(!pickResult) return;
    var checked = dialogHost && dialogHost.shadowRoot && dialogHost.shadowRoot.querySelector('input[name=\w333-attr\]:checked');
    var attribute = checked ? checked.value : 'text';
    saveBtn.disabled=true; msgEl.textContent=''; msgEl.classList.remove('error');
    chrome.runtime.sendMessage({type:'save-element-monitor', pick: pickResult, attribute: attribute}).then(function(res){
      if(res && res.ok){ try{ chrome.storage.sync.remove('pendingPick'); }catch(e){} showToast(res.mode==='updated' ? '已更新监控' : '已添加监控'); cleanup(); }
      else { msgEl.textContent=(res&&res.error)||'保存失败，请重试'; msgEl.classList.add('error'); saveBtn.disabled=false; }
    }).catch(function(err){ console.error('[333 Watcher] save picked failed',err); msgEl.textContent='保存失败：'+(err.message||'未知错误'); msgEl.classList.add('error'); saveBtn.disabled=false; });
  }

  function showToast(text){
    var host=document.createElement('div'); host.setAttribute('data-w333','toast');
    host.style.cssText='position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
    var shadow=host.attachShadow({mode:'open'}); var style=document.createElement('style'); style.textContent=TOAST_CSS;
    var box=document.createElement('div'); box.className='w333-toast'; box.textContent=text; shadow.appendChild(style); shadow.appendChild(box);
    appendSafe(host); setTimeout(function(){ try{ host.remove(); }catch(e){} }, 2800);
  }

  window.__w333PickerCleanup = cleanup;
  window.__w333PickerDebug = { overlay: overlay, tip: tip, badge: badge, highlight: highlight };
  function cleanup(){
    stopPickMode();
    try{ overlay.remove(); }catch(e){} try{ tip.remove(); }catch(e){} try{ badge && badge.remove(); }catch(e){}
    if(dialogHost) try{ dialogHost.remove(); }catch(e){}
    dialogHost=null; pickResult=null; window.__w333PickerActive=false;
    document.removeEventListener('keydown', onKey, true); window.removeEventListener('keydown', onKey, true);
  }
  chrome.runtime.onMessage.addListener(function(msg){ if(msg && msg.type==='w333-close-dialog') cleanup(); });

  startPickMode();
  showToast('已进入选择模式：鼠标移动高亮，点击选中，Esc 退出');
})();
