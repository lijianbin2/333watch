 /**
 * 333 Watcher - Offscreen Document (v0.6.43)
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

// 架构 / 平台 / 渠道标记：这些是下载地址的**身份**，不能被版本剥离规则吃掉。
// 与 picker.js 里的同名实现必须保持一致（首次拾取和选择器自愈要给出同一个选择器）。
const QUALIFIER_TOKEN = /^(arm|arm64|armhf|aarch64|x64|x86|x86_64|amd64|64|32|386|i386|ia32|win|win32|win64|windows|winnt|linux|musl|gnu|mac|macos|osx|darwin|intel|bit|bits|insider|beta|alpha|rc|preview|universal|any|setup|bin|src)$/i;
const VERSION_TOKEN = /^v?\d+$/i;
// 站点标记：某些下载页把**所有**下载项都放在同一个路径下（微信开发者工具页的
// x64 / arm64 / .dmg 链接全带 wechat_devtools）。这种标记本身零区分度，
// 只能当**附加**条件，永远不能单独构成选择器。
// picker.js 里的同名表多一个 wxqcloud（那边能拿到绝对 URL 的主机名，本文件
// 没有 baseUrl 拿不到），两处必须保持包含关系，见 tests/offscreen-review.test.cjs。
const SITE_MARKS = ['wechat_devtools'];
// 只有真正的下载扩展名才允许退化成 `a[href$=".exe"]`。否则 /docs/v1.2 这类
// 普通导航链接会被当成下载项，整个页面的文档链接全部塌缩成同一个选择器。
const DOWNLOAD_EXT = /^\.(exe|msi|msix|appx|appimage|apk|deb|rpm|dmg|pkg|zip|7z|rar|tar|gz|tgz|bz2|xz|iso|img|bin|jar|war|crx|xpi|whl)$/i;
// 纯数字段：既可能是版本号，也可能是位数（putty-64-bit）。
// 只有"纯数字且不是标记"才算版本号，64/32 已在标记表里，因此不会被剥掉。
function isVersionToken(t) { return VERSION_TOKEN.test(t) && !QUALIFIER_TOKEN.test(t); }

function siteMarks(href) {
  const hay = String(href || '');
  const out = [];
  for (const m of SITE_MARKS) if (hay.includes(m)) out.push(m);
  return out;
}

// 扩展名保底：只在白名单里才算下载项，返回 null 表示"这不是下载链接"。
function downloadExt(href) {
  const path = String(href || '').split(/[?#]/)[0];
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot);
  return DOWNLOAD_EXT.test(ext) ? ext : null;
}

// 从 href 里取出"扩展名 + 稳定词干 + 架构标记"，用作下载链接的属性选择器。
// 只靠 `a[href$=".exe"]` 在多下载项页面（多版本、多架构、不同产品）永远命中
// 第一个 a，监控会盯错链接；但写死完整文件名又会在版本升级改名后直接失效。
// 因此：扩展名保底（版本号变化不影响）+ 版本号之前的词干 + 架构/平台标记
// （同产品的不同版本都命中，不同架构/产品不会互相串）。
// 返回 null 表示区分度不足，退回宽松选择器。
function downloadSelectorParts(href) {
  const raw = String(href || '');
  // 去掉查询串/片段：签名链接的 token 每次都变，绝不能进选择器。
  const path = raw.split(/[?#]/)[0];
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const stem = base.slice(0, dot);
  const ext = base.slice(dot);

  // 按 [._-] 切段并记住每段在 stem 里的结束位置：head/tail 都必须是原串的
  // **连续切片**，不能把切开的段重新拼起来（putty-64 的段拼成 "putty64"，
  // 而 href 里是 "putty-64"，substring 匹配会直接失配）。
  const segs = [];
  const re = /[^._-]+/g;
  let m;
  while ((m = re.exec(stem))) segs.push({ t: m[0], e: m.index + m[0].length });

  // 末尾连续的标记段（win-x64 / 64-bit / x64-insider）单独作为附加条件。
  // v0.6.33 用一条"剥掉末尾数字"的正则把 arm64、x64、win、linux 一起剥掉了，
  // 于是同产品的不同架构又塌缩成同一个 hint：用户点 arm64，监控却盯上 x64。
  let tStart = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (QUALIFIER_TOKEN.test(segs[i].t)) { tStart = i; break; }
  }
  if (tStart >= 0) {
    while (tStart > 0 && QUALIFIER_TOKEN.test(segs[tStart - 1].t)) tStart--;
  }
  const cut = tStart >= 0 ? tStart : segs.length;
  const tailSegs = segs.slice(cut);
  while (tailSegs.length && isVersionToken(tailSegs[tailSegs.length - 1].t)) tailSegs.pop();
  // 头部剥掉末尾版本段：WeChatSetup_4.0.6.19 -> WeChatSetup
  const headSegs = segs.slice(0, cut);
  while (headSegs.length && isVersionToken(headSegs[headSegs.length - 1].t)) headSegs.pop();

  // 必须是 let：下面 head 为空时要把整段 stem 兜底回 hint（setup.exe / bin.zip
  // 这类"文件名整体就是一个标记"的文件会走到这里）。写成 const 会抛
  // TypeError，整条监控的选择器自愈就此挂掉。
  let head = headSegs.length ? stem.slice(0, headSegs[headSegs.length - 1].e) : '';
  const tail = tailSegs.map((s) => s.t);
  if (!head) { head = stem; tail.length = 0; }   // 整段都是标记（arm64.exe）时整段当 hint

  // 至少 3 个字母才算有区分度：a.exe / 1.exe / ab12.exe 这类只加噪音。
  const letters = (head + tail.join('')).match(/[a-z]/gi) || [];
  if (letters.length < 3) return null;
  // head 太短时 substring 太泛（a-arm64 几乎命中全页），宁可退回宽松选择器。
  if (tail.length && ((head.match(/[a-z]/gi) || []).length < 2)) return null;
  // 用原始（未解码）词干：percent-encoded 的 href 里字面量必须对得上，
  // 否则选择器会匹配不到任何元素。
  return { ext, hint: head, tail };
}

// 每个 tail 标记单独成一个条件，而不是拼成 "win-x64"：
// 分隔符样式（-/_/.）各站点不同，逐段匹配才不会因为分隔符不同而失配。
// 站点标记以同样方式追加在末尾。
function buildDownloadSelector(parts, marks) {
  let sel = 'a[href$=' + quoteAttr(parts.ext) + '][href*=' + quoteAttr(parts.hint) + ']';
  for (const t of parts.tail) sel += '[href*=' + quoteAttr(t) + ']';
  for (const m of marks || []) sel += '[href*=' + quoteAttr(m) + ']';
  return sel;
}

function buildSelector(el) {
  // 下载链接（a 标签）优先返回稳定的属性选择器。
  // 只在 tagName 确实是 A 时才走这条：href 属性选择器只会匹配 a，
  // 给 <link>/<area> 生成 a[...] 会让自愈永远定位不到元素。
  if (el.tagName === 'A') {
    const h = el.getAttribute('href')||'';
    // 下载链接必须带上区分标记，否则多下载项页面永远命中第一个 a：
    // 自愈把别的链接当成目标，既立刻误报一次"已变化"，真目标后续怎么变都发现不了。
    // v0.6.36：wechat_devtools/wxqcloud 这类站点标记只在**全站共享**时毫无区分度，
    // 旧实现直接 `return a[href*="wechat_devtools"]`，于是旗舰场景里 x64、arm64、
    // .dmg 三种下载全部塌缩成同一个选择器。现在标记只作为附加条件，
    // 区分主体交给扩展名 + 词干 + 架构标记。
    const parts = downloadSelectorParts(h);
    const marks = siteMarks(h);
    if (parts) return buildDownloadSelector(parts, marks);
    const ext = downloadExt(h);
    if (!ext) { /* 落到结构化选择器 */ }
    else {
      let sel = 'a';
      for (const m of marks) sel += '[href*=' + quoteAttr(m) + ']';
      return sel + '[href$=' + quoteAttr(ext) + ']';
    }
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

