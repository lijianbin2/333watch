const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const offscreenPath = path.join(__dirname, '..', 'offscreen.js');
const source = fs.readFileSync(offscreenPath, 'utf8');

// offscreen.js 顶层只注册一个 message listener，没有 DOM 依赖，
// 所以用最小桩就能把内部函数取出来直接断言。
function loadOffscreen({ css } = {}) {
  const context = {
    console,
    DOMParser: class {
      parseFromString() {
        return { querySelectorAll: () => [], querySelector: () => null };
      }
    },
    chrome: { runtime: { onMessage: { addListener() {} } } },
  };
  if (css) context.CSS = css;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source + '\n;globalThis.__api = { buildSelector, cssEscape };', context);
  return context.__api;
}

// buildSelector 的 a 分支只需要 tagName / getAttribute。
function anchor(href) {
  return { tagName: 'A', getAttribute: (n) => (n === 'href' ? href : null) };
}

// ---------------- buildSelector：下载链接的选择器 ----------------
// 自愈用的 buildSelector 对任何 .exe 链接都返回同一个 `a[href$=".exe"]`。
// 下载页同时提供多个下载项时（.exe/.dmg/.msi，或多版本 .exe），querySelector
// 永远命中第一个：匹配到别的链接后 checkElement 会拿它的 href 和基线一比，
// 立刻误报一次"已变化"，而真正被监控的那个链接后续怎么变都不会被发现。
const { buildSelector } = loadOffscreen();
const winSel = buildSelector(anchor('/dl/WeChatSetup.exe'));
assert.ok(
  winSel.includes('$=".exe"'),
  'the .exe branch must keep the extension match, got: ' + winSel
);
assert.ok(
  winSel.includes('WeChatSetup'),
  'the .exe selector must pin the product stem, got: ' + winSel
);
assert.notEqual(
  winSel,
  buildSelector(anchor('/dl/OtherSetup.exe')),
  'two different .exe links must not collapse to one identical selector'
);
assert.notEqual(
  winSel,
  buildSelector(anchor('/dl/WeChat.dmg')),
  'a .dmg link must not collapse into the .exe selector either'
);
assert.ok(
  buildSelector(anchor('/dl/WeChat.dmg')).includes('WeChat'),
  'non-exe download links must also get a distinguishing selector'
);
// 同一条链接必须稳定重建，否则每次自愈都在换选择器。
assert.equal(buildSelector(anchor('/dl/WeChatSetup.exe')), winSel, 'selector building must be deterministic');
// 版本升级只改版本号：选择器必须保持不变，否则每次发新版监控都会失效。
assert.equal(
  buildSelector(anchor('/dl/WeChatSetup_4.0.6.19.exe')),
  winSel,
  'a version bump must not invalidate the selector'
);
// 带签名/鉴权参数的 href：查询串里 token 每次都在变，选择器不能带上。
const signed = buildSelector(anchor('/dl/WeChatSetup.exe?token=a1b2&t=99'));
assert.ok(
  !/token=/.test(signed) && signed.includes('WeChatSetup'),
  'the selector must ignore volatile query strings, got: ' + signed
);
// 文件名没有区分度（a.exe）时不要加提示，保持旧的宽松选择器。
assert.equal(
  buildSelector(anchor('/dl/a.exe')),
  'a[href$=".exe"]',
  'a non-distinguishing file name must not add a hint'
);
// 普通导航链接仍走结构路径，不要被改成属性选择器。
const navSel = buildSelector({ tagName: 'A', getAttribute: () => '/pricing' });
assert.ok(!/\[href/.test(navSel), 'plain navigation links must not become attribute selectors, got: ' + navSel);
// wechat_devtools 专用分支保持原样。
assert.equal(
  buildSelector(anchor('https://dldir1.qq.com/wechat_devtools/x86/setup.exe')),
  'a[href*="wechat_devtools"]',
  'the wechat_devtools branch must be preserved'
);

// ---------------- cssEscape：无 CSS.escape 时的回退 ----------------
// 回退只把非法字符加反斜杠，不处理前导数字：id 为 `123abc` 时会生成
// `#123abc`，这是非法选择器，offscreen 侧 querySelector 直接抛错。
const { cssEscape } = loadOffscreen();
assert.equal(cssEscape('123abc'), '\\31 23abc', 'a leading digit must be hex-escaped in the fallback');
assert.equal(cssEscape('-5x'), '-\\35 x', 'a leading dash-digit must be hex-escaped in the fallback');
assert.equal(cssEscape('a.b'), 'a\\.b', 'non-identifier characters stay escaped');
assert.equal(cssEscape('has space'), 'has\\ space', 'whitespace stays escaped');
assert.equal(cssEscape('plain-Id_1'), 'plain-Id_1', 'valid identifiers are left alone');
// 有 CSS.escape 时直接用原生实现。
const native = loadOffscreen({ css: { escape: (v) => 'NATIVE:' + v } });
assert.equal(native.cssEscape('123abc'), 'NATIVE:123abc', 'native CSS.escape must be preferred when present');

console.log('offscreen-review tests passed');
