const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pickerPath = path.join(__dirname, '..', 'picker.js');
const source = fs.readFileSync(pickerPath, 'utf8');

// picker.js 是一个 IIFE，加载时就会建 overlay、挂事件、开轮询。
// 这里用一个"什么都能吞"的最小 DOM 桩把它跑起来，再把内部的 getSelector
// 暴露出来直接断言——比复制一份逻辑出来测要有意义得多。
function makeStubEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    id: '',
    style: {},
    dataset: {},
    children: [],
    parentElement: null,
    textContent: '',
    innerHTML: '',
    className: '',
    attributes: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() {},
    attachShadow() { return { appendChild() {} }; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }; },
    focus() {},
  };
  return el;
}

function loadPicker() {
  const doc = makeStubEl('document');
  doc.documentElement = makeStubEl('html');
  doc.body = makeStubEl('body');
  doc.createElement = (tag) => makeStubEl(tag);
  doc.createTextNode = (t) => ({ textContent: t });
  doc.elementFromPoint = () => null;
  doc.execCommand = () => true;

  const win = {
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    getComputedStyle: () => ({}),
    location: { href: 'https://dl.test/page' },
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
    setTimeout: () => 0,
    clearTimeout() {},
  };

  const context = {
    console,
    document: doc,
    window: win,
    location: win.location,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    getComputedStyle: win.getComputedStyle,
    URL,
    CSS: { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch) },
    chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} }, sendMessage: () => Promise.resolve({}) } },
  };
  context.globalThis = context;
  vm.createContext(context);
  // getSelector / cleanup 是 IIFE 内部的函数，在收尾前挂出来供断言。
  const patched = source.replace(
    /\n\}\)\(\);\s*$/,
    '\nwindow.__getSelector = getSelector;\nwindow.__callCleanup = cleanup;\n})();\n'
  );
  assert.notEqual(patched, source, 'picker.js 尾部结构变了，测试需要重新定位内部函数的挂载点');
  vm.runInContext(patched, context);
  assert.equal(typeof win.__getSelector, 'function', 'getSelector must be reachable from the test');
  assert.equal(typeof win.__callCleanup, 'function', 'cleanup must be reachable from the test');
  return { getSelector: win.__getSelector, cleanup: win.__callCleanup, win: win };
}

function anchor(href) {
  const el = makeStubEl('a');
  el.setAttribute('href', href);
  el.href = href;
  el.closest = (sel) => (sel === 'a' ? el : null);
  return el;
}

// ---------------- getSelector：下载链接 ----------------
// 旧实现对任意 .exe 链接返回同一个 `a[href$=".exe"]`。下载页同时提供多个下载项时
// （多版本 / 多架构 / 不同产品），用户点第三个，监控盯的却是第一个：首次检查就会
// 拿第一个的 href 和第三个的基线一比，误报一次"已变化"，之后真目标怎么变都不知道。
const loaded = loadPicker();
const getSelector = loaded.getSelector;
const sel1 = getSelector(anchor('/dl/WeChatSetup.exe'));
assert.ok(
  sel1.includes('$=".exe"'),
  'the extension guard must survive so a version bump keeps matching, got: ' + sel1
);
assert.ok(
  sel1.includes('WeChatSetup'),
  'the selector must pin the product stem, got: ' + sel1
);
assert.notEqual(
  sel1,
  getSelector(anchor('/dl/QQSetup.exe')),
  'two different .exe products must not collapse to one identical selector'
);
assert.notEqual(
  sel1,
  getSelector(anchor('/dl/WeChat.dmg')),
  'a .dmg link must not collapse into the .exe selector'
);
// 版本升级只改版本号：选择器必须保持不变，否则每次发新版监控都会失效。
assert.equal(
  getSelector(anchor('/dl/WeChatSetup_4.0.6.19.exe')),
  sel1,
  'a version bump must not invalidate the selector'
);
// 架构后缀要能区分：x64 / arm64 仍是同一个 stem 家族，这里只断言不抛异常且稳定。
const x64 = getSelector(anchor('/dl/WeChatSetup_x64.exe'));
assert.equal(x64, getSelector(anchor('/dl/WeChatSetup_x64.exe?v=2')), 'query strings must not change the selector');
assert.ok(!/v=2/.test(x64), 'volatile query strings must stay out of the selector, got: ' + x64);
// 区分度不足的名字不加提示，保持旧的宽松行为。
assert.equal(getSelector(anchor('/dl/a.exe')), 'a[href$=".exe"]', 'a non-distinguishing name must not add a hint');
// 站点标记只作附加条件，不能单独构成选择器。
// 微信开发者工具下载页上每个链接都带 wechat_devtools 路径，
// 旧实现直接返回 a[href*="wechat_devtools"]，x64 / arm64 / .dmg 全塌缩成一个。
assert.equal(
  getSelector(anchor('https://dldir1.qq.com/wechat_devtools/x86/setup.exe')),
  'a[href$=".exe"][href*="setup"][href*="wechat_devtools"]',
  'the wechat_devtools site mark must survive as an extra condition'
);
const flagship = [
  'https://dldir1.qq.com/wechat_devtools/Windows/WeChatSetup.exe',
  'https://dldir1.qq.com/wechat_devtools/Windows/WeChatSetup_arm64.exe',
  'https://dldir1.qq.com/wechat_devtools/Mac/WeChatSetup.dmg',
].map((h) => getSelector(anchor(h)));
assert.equal(new Set(flagship).size, 3, 'x64 / arm64 / .dmg must not share a selector, got: ' + flagship.join(' | '));
// wxqcloud 是靠主机名识别的标记：主机名出现在 a.href 里，不在 getAttribute('href') 里。
assert.ok(
  getSelector(anchor('https://dldir1.qq.com/wxqcloud/WeChat.exe')).includes('wxqcloud'),
  'a wxqcloud-hosted download must keep its site mark'
);
// 普通导航链接仍走结构路径，不要被改成属性选择器。
const navSel = getSelector(anchor('/pricing'));
assert.ok(!/\[href/.test(navSel), 'plain navigation links must not become attribute selectors, got: ' + navSel);
// 带点但区分度不足的导航链接不能退化成裸 a[href$=".x"]。
for (const navHref of ['/docs/v1.2', '/users/a.b']) {
  const sel = getSelector(anchor(navHref));
  assert.ok(
    !/\[href\$=".2"\]|\[href\$=".b"\]/.test(sel),
    'a low-signal navigation link must not become a bare extension selector: ' + navHref + ' -> ' + sel
  );
}

// ---------------- 发布版不得裸打 console ----------------
// picker 跑在用户正在访问的任意页面里。发布版残留 console.log 有三重代价：
// 把宿主页面 URL、选中元素的文字和链接写进别人的站点控制台（隐私），
// 在对方站点的控制台里留下无法解释的第三方日志（观感），
// 以及 console.log(overlay, tip, badge) 这种把 DOM 节点交给 devtools 持有 ——
// 节点在 cleanup() 里 remove() 之后依然不会被回收（泄漏）。
const bareLogs = source
  .split('\n')
  .map((line, i) => ({ line: line, n: i + 1 }))
  .filter((x) => /(^|[^.\w])console\s*\.\s*log\s*\(/.test(x.line))
  // dbg() 自己那一行是唯一豁免（它就是那个受 DEBUG 开关约束的包装）。
  .filter((x) => !/function\s+dbg\s*\(/.test(x.line));
assert.equal(
  bareLogs.length,
  0,
  'picker.js must not call console.log directly in release builds, found:\n' +
    bareLogs.map((x) => x.n + ': ' + x.line.trim()).join('\n')
);

// ---------------- cleanup 必须释放调试句柄 ----------------
// 用户在同一页面反复点「选择元素」时 content script 上下文是复用的。
// 旧实现把 overlay/tip/badge 挂在 window.__w333PickerDebug 上，cleanup 从不摘，
// 于是每点一次选择器，window 上就多留一份指向已移除节点的活引用。
assert.ok(loaded.win.__w333PickerDebug, 'the debug handle must exist while the picker is active');
loaded.cleanup();
assert.equal(
  loaded.win.__w333PickerDebug,
  undefined,
  'cleanup must release the debug handle so repeated injections do not pile up DOM references'
);
assert.equal(loaded.win.__w333PickerActive, false, 'cleanup must clear the active flag');

console.log('picker-review tests passed');
