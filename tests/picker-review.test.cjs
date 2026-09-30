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
  // getSelector 是 IIFE 内部的函数，在收尾前挂出来供断言。
  const patched = source.replace(/\n\}\)\(\);\s*$/, '\nwindow.__getSelector = getSelector;\n})();\n');
  assert.notEqual(patched, source, 'picker.js 尾部结构变了，测试需要重新定位 getSelector 的挂载点');
  vm.runInContext(patched, context);
  assert.equal(typeof win.__getSelector, 'function', 'getSelector must be reachable from the test');
  return win.__getSelector;
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
const getSelector = loadPicker();
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
// 微信开发者工具专用分支保持原样。
assert.equal(
  getSelector(anchor('https://dldir1.qq.com/wechat_devtools/x86/setup.exe')),
  'a[href*="wechat_devtools"]',
  'the wechat_devtools branch must be preserved'
);
// 普通导航链接仍走结构路径，不要被改成属性选择器。
const navSel = getSelector(anchor('/pricing'));
assert.ok(!/\[href/.test(navSel), 'plain navigation links must not become attribute selectors, got: ' + navSel);

console.log('picker-review tests passed');
