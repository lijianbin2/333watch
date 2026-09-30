/**
 * 333 Watcher - 元素选择器 Content Script v0.6.40
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
    console.log('[333 Watcher] picker overlay injected v0.6.40', overlay, tip, badge, location.href);

  // 下载链接的选择器：扩展名保底（版本升级改名后仍然命中），再加文件名词干做区分。
  // 只用 `a[href$=".exe"]` 时，多下载项页面（多版本、多架构、不同产品）永远命中
  // 第一个 a：用户点的是第三个，监控却盯住第一个——首次检查立刻误报一次
  // "已变化"，之后真正的目标链接怎么变都不会被发现。
  // 架构 / 平台 / 渠道标记：这些是下载地址的**身份**，不能被版本剥离规则吃掉。
  var QUALIFIER_TOKEN = /^(arm|arm64|armhf|aarch64|x64|x86|x86_64|amd64|64|32|386|i386|ia32|win|win32|win64|windows|winnt|linux|musl|gnu|mac|macos|osx|darwin|intel|bit|bits|insider|beta|alpha|rc|preview|universal|any|setup|bin|src)$/i;
  var VERSION_TOKEN = /^v?\d+$/i;
  // 站点标记只能当**附加**条件：微信开发者工具页里 x64 / arm64 / .dmg 的链接
  // 全都带 wechat_devtools，只用它做选择器会把三种下载全塌缩成一个。
  // wxqcloud 只能靠主机名识别（这里是 DOM 环境，有 a.href 绝对地址；
  // offscreen.js 无 baseURL，取不到主机名，故那张表更短）。
  var SITE_MARKS = ['wechat_devtools', 'wxqcloud'];
  // 退化成 `a[href$=".exe"]` 之前先确认扩展名确实是下载项，
  // 否则 /docs/v1.2 这类导航链接会被误当成下载链接。
  var DOWNLOAD_EXT = /^\.(exe|msi|msix|appx|appimage|apk|deb|rpm|dmg|pkg|zip|7z|rar|tar|gz|tgz|bz2|xz|iso|img|bin|jar|war|crx|xpi|whl)$/i;
  // 纯数字段：既可能是版本号，也可能是位数（putty-64-bit）。
  // 只有"纯数字且不是标记"才算版本号，64/32 已在标记表里，因此不会被剥掉。
  function isVersionToken(t) { return VERSION_TOKEN.test(t) && !QUALIFIER_TOKEN.test(t); }
  function attrQuote(value) { return JSON.stringify(String(value)); }

  function siteMarks(href, absHref) {
    var hay = String(href || '') + ' ' + String(absHref || '');
    var out = [];
    for (var i = 0; i < SITE_MARKS.length; i++) {
      if (hay.indexOf(SITE_MARKS[i]) !== -1) out.push(SITE_MARKS[i]);
    }
    return out;
  }

  function downloadExt(href) {
    var path = String(href || '').split(/[?#]/)[0];
    var base = path.slice(path.lastIndexOf('/') + 1);
    var dot = base.lastIndexOf('.');
    if (dot <= 0) return null;
    var ext = base.slice(dot);
    return DOWNLOAD_EXT.test(ext) ? ext : null;
  }

  function downloadSelectorParts(href) {
    var raw = String(href || '');
    var path = raw.split(/[?#]/)[0];           // 签名链接的 token 每次都变，不能进选择器
    var base = path.slice(path.lastIndexOf('/') + 1);
    var dot = base.lastIndexOf('.');
    if (dot <= 0) return null;
    var stem = base.slice(0, dot);
    var ext = base.slice(dot);

    // 按 [._-] 切段并记住每段在 stem 里的结束位置：head/tail 都必须是原串的
    // **连续切片**，不能把切开的段重新拼起来（putty-64 的段拼成 "putty64"，
    // 而 href 里是 "putty-64"，substring 匹配会直接失配）。
    var segs = [], re = /[^._-]+/g, m;
    while ((m = re.exec(stem))) segs.push({ t: m[0], e: m.index + m[0].length });

    // 末尾连续的标记段（win-x64 / 64-bit / x64-insider）单独作为附加条件。
    // v0.6.33 用一条"剥掉末尾数字"的正则把 arm64、x64、win、linux 一起剥掉了，
    // 于是同产品的不同架构又塌缩成同一个 hint：用户点 arm64，监控却盯上 x64。
    var tStart = -1, i;
    for (i = segs.length - 1; i >= 0; i--) { if (QUALIFIER_TOKEN.test(segs[i].t)) { tStart = i; break; } }
    if (tStart >= 0) { while (tStart > 0 && QUALIFIER_TOKEN.test(segs[tStart - 1].t)) tStart--; }
    var cut = tStart >= 0 ? tStart : segs.length;
    var tailSegs = segs.slice(cut);
    while (tailSegs.length && isVersionToken(tailSegs[tailSegs.length - 1].t)) tailSegs.pop();
    // 头部剥掉末尾版本段：WeChatSetup_4.0.6.19 -> WeChatSetup
    var headSegs = segs.slice(0, cut);
    while (headSegs.length && isVersionToken(headSegs[headSegs.length - 1].t)) headSegs.pop();

    var head = headSegs.length ? stem.slice(0, headSegs[headSegs.length - 1].e) : '';
    var tail = [];
    for (i = 0; i < tailSegs.length; i++) tail.push(tailSegs[i].t);
    if (!head) { head = stem; tail = []; }   // 整段都是标记（arm64.exe）时整段当 hint

    var letters = (head + tail.join('')).match(/[a-z]/gi) || [];
    if (letters.length < 3) return null;                            // 至少 3 个字母才有区分度
    if (tail.length && ((head.match(/[a-z]/gi) || []).length < 2)) return null;  // head 太短，substring 太泛
    return { ext: ext, hint: head, tail: tail };
  }

  // 每个 tail 标记单独成一个条件，而不是拼成 "win-x64"：
  // 分隔符样式（-/_/.）各站点不同，逐段匹配才不会因为分隔符不同而失配。
  function buildDownloadSelector(parts, marks) {
    var sel = 'a[href$=' + attrQuote(parts.ext) + '][href*=' + attrQuote(parts.hint) + ']';
    for (var i = 0; i < parts.tail.length; i++) {
      sel += '[href*=' + attrQuote(parts.tail[i]) + ']';
    }
    if (marks) for (var j = 0; j < marks.length; j++) sel += '[href*=' + attrQuote(marks[j]) + ']';
    return sel;
  }

  function getSelector(el) {
    if (!el || !el.tagName) return 'body';
    if (el.tagName === 'A' || (el.closest && el.closest('a'))) {
      var a = (el.closest && el.closest('a')) || el;
      var href = (a.getAttribute && a.getAttribute('href')) || '';
      var marks = siteMarks(href, a.href);
      var parts = downloadSelectorParts(href);
      if (parts) return buildDownloadSelector(parts, marks);
      var ext = downloadExt(href);
      if (ext) {
        var sel = 'a';
        for (var k = 0; k < marks.length; k++) sel += '[href*=' + attrQuote(marks[k]) + ']';
        return sel + '[href$=' + attrQuote(ext) + ']';
      }
    }
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute && el.getAttribute('data-testid')) return el.tagName.toLowerCase() + '[data-testid="' + String(el.getAttribute('data-testid')).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
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
    return (el.textContent||'').replace(/\s+/g,' ').trim();
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
    reselectBtn.addEventListener('click', function(){
      if(dialogHost) dialogHost.remove(); dialogHost=null;
      // 重新选择意味着放弃这次结果：清掉 pendingPick，否则下次打开 popup 会自动
      // 回填一个用户已经放弃的陈旧选择。
      try{ chrome.storage.sync.remove('pendingPick'); }catch(e){}
      pickResult=null;
      startPickMode(); if(badge) badge.style.display='block';
    });
    if(badge) badge.style.display='none';
  }

  function savePicked(saveBtn, msgEl){
    if(!pickResult) return;
    var checked = dialogHost && dialogHost.shadowRoot && dialogHost.shadowRoot.querySelector('input[name="w333-attr"]:checked');
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
  function onRuntimeMessage(msg){ if(msg && msg.type==='w333-close-dialog') cleanup(); }
  function cleanup(){
    stopPickMode();
    try{ overlay.remove(); }catch(e){} try{ tip.remove(); }catch(e){} try{ badge && badge.remove(); }catch(e){}
    if(dialogHost) try{ dialogHost.remove(); }catch(e){}
    dialogHost=null; pickResult=null; window.__w333PickerActive=false;
    document.removeEventListener('keydown', onKey, true); window.removeEventListener('keydown', onKey, true);
    // 同一页面反复注入选择器时，content script 上下文是复用的：
    // 不摘掉监听器会每次注入都多留一个，指向已被清理的旧闭包。
    try{ chrome.runtime.onMessage.removeListener(onRuntimeMessage); }catch(e){}
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  startPickMode();
  showToast('已进入选择模式：鼠标移动高亮，点击选中，Esc 退出');
})();
