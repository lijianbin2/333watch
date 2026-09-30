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
// 带点但**区分度不足**的导航链接不能退化成裸 a[href$=".x"]。
// （有足够词干的如 /CHANGELOG.md 拿到的是"扩展名+词干"的稳定选择器，那是好事。）
for (const navHref of ['/docs/v1.2', '/users/a.b']) {
  const sel = buildSelector(anchor(navHref));
  assert.ok(
    !/\[href\$=".2"\]|\[href\$=".b"\]/.test(sel),
    'a low-signal navigation link must not become a bare extension selector: ' + navHref + ' -> ' + sel
  );
}
// 站点标记降级为附加条件。
// v0.6.33~35：href 里带 wechat_devtools 就直接 return a[href*="wechat_devtools"]。
// 但微信开发者工具下载页上**每一个**链接都带这个路径（x64 / arm64 / .dmg 全都带），
// 零区分度 —— 三种下载塌缩成同一个选择器，自愈必然盯错链接。
// 现在标记只是附加条件，区分主体交给扩展名 + 词干 + 架构标记。
assert.equal(
  buildSelector(anchor('https://dldir1.qq.com/wechat_devtools/x86/setup.exe')),
  'a[href$=".exe"][href*="setup"][href*="wechat_devtools"]',
  'the wechat_devtools site mark must survive as an extra condition'
);
// 旗舰场景：同一页面上 x64 / arm64 / .dmg 三种下载必须给出三个不同选择器。
// （旧实现三种全塌缩成 a[href*="wechat_devtools"]，querySelector 只命中第一个。）
const flagshipHrefs = [
  'https://dldir1.qq.com/wechat_devtools/Windows/WeChatSetup.exe',
  'https://dldir1.qq.com/wechat_devtools/Windows/WeChatSetup_arm64.exe',
  'https://dldir1.qq.com/wechat_devtools/Mac/WeChatSetup.dmg',
];
const flagshipSels = flagshipHrefs.map((h) => buildSelector(anchor(h)));
assert.equal(
  new Set(flagshipSels).size,
  3,
  'x64 / arm64 / .dmg downloads on one page must not share a selector, got: ' + flagshipSels.join(' | ')
);
// 已知取舍：x64 那个链接的文件名是 arm64 那个的**前缀**（WeChatSetup 是
// WeChatSetup_arm64 的子串），而 CSS 属性选择器无法表达"href 里 stem 之后
// 不许再跟别的标记"。所以 x64 选择器会顺带命中 arm64；反过来 arm64 选择器
// 带了 [href*="arm64"]，不会命中 x64。这个方向性偏差是可接受的：
// 它等价于 v0.6.33 之前的"命中第一个"，而不会再退化成三种下载一个选择器。
assert.deepEqual(
  flagshipHrefs.filter((h) => matchDownloadSelector(flagshipSels[1], h)),
  [flagshipHrefs[1]],
  'the arm64 selector must match the arm64 link only, got: ' + flagshipSels[1]
);
// .dmg 两侧都不会被 .exe 的选择器捞走（扩展名保底）。
assert.ok(!matchDownloadSelector(flagshipSels[0], flagshipHrefs[2]), 'the .exe selector must not match the .dmg link');
assert.ok(!matchDownloadSelector(flagshipSels[2], flagshipHrefs[0]), 'the .dmg selector must not match a .exe link');
// 微信页发新版只改版本号：选择器必须保持不变。
assert.equal(
  buildSelector(anchor('https://dldir1.qq.com/wechat_devtools/Windows/WeChatSetup_4.0.6.19_arm64.exe')),
  flagshipSels[1],
  'a WeChat devtools version bump must not invalidate the arm64 selector'
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

// ---------------- buildSelector：同产品不同架构不能塌缩 ----------------
// v0.6.33 修好了"多产品"塌缩（WeChatSetup vs QQSetup），但它用一条
// "剥掉末尾数字"的正则来去版本号，把 arm64 / x64 / win / linux / 64-bit
// 这些**架构平台标记**一起剥掉了 —— 它们同样是纯数字或以数字结尾的段。
// 结果同产品的不同架构又生成同一个选择器：
//   WeChatSetup_4.0.6.19.exe  和  WeChatSetup_4.0.6.19_arm64.exe
//   ->  都是 a[href$=".exe"][href*="WeChatSetup"]
// querySelector 只会命中第一个：用户点的是 arm64，监控盯的却是 x64。
// 后果和 v0.6.33 一样 —— 首次检查立刻误报一次"已变化"，之后真目标怎么变都发现不了。

// 迷你匹配器：只解析 buildSelector 实际会生成的那种形状
// （a[href$=".."][href*=".."]...），用来直接断言"这个选择器只命中目标链接"。
function matchDownloadSelector(selector, href) {
  const conds = [...selector.matchAll(/\[href([$*]?)="((?:[^"\\]|\\.)*)"\]/g)].map(
    ([, op, raw]) => [op, JSON.parse('"' + raw + '"')]
  );
  if (!conds.length) return false;
  return conds.every(([op, val]) => {
    if (op === '$') return href.endsWith(val);
    if (op === '*') return href.includes(val);
    return href === val;
  });
}
// 页面上真实存在的其它下载项：用来验证"不串台"。
const pageHrefs = [
  'https://dldir1.qq.com/wechat_devtools/Windows/WeChatSetup_4.0.6.19.exe',
  'https://dldir1.qq.com/wechat_devtools/Windows/WeChatSetup_4.0.6.19_arm64.exe',
  'https://dldir1.qq.com/wechat_devtools/Mac/WeChatSetup.dmg',
  'https://dldir1.qq.com/qq/QQSetup.exe',
];
const arm64Href = pageHrefs[1];
const arm64Sel = buildSelector(anchor(arm64Href));
assert.ok(
  arm64Sel.includes('arm64'),
  'an arm64 download must keep its architecture in the selector, got: ' + arm64Sel
);
assert.notEqual(
 buildSelector(anchor(pageHrefs[0])),
  arm64Sel,
  'x64 and arm64 builds of the same product must not share a selector'
);
// 关键断言：arm64 的选择器只命中 arm64 那个链接，命中 x64 就是串台。
assert.deepEqual(
  pageHrefs.filter((h) => matchDownloadSelector(arm64Sel, h)),
  [arm64Href],
  'the arm64 selector must match the arm64 link only, got: ' + arm64Sel
);
// 反向：x64 的选择器也不能把 arm64 一起捞进来。
const x64Sel = buildSelector(anchor(pageHrefs[0]));
// 已知取舍：x64 选择器为了"发版不失效"必须剥掉版本号，而 arm64 那个链接的
// stem 就是 x64 的 stem（`WeChatSetup` 是 `WeChatSetup_arm64` 的子串），
// CSS 属性选择器没有"stem 之后不许再跟标记"的写法。
// 结论：版本鲁棒性优先，x64 选择器会同时命中两个 .exe；方向性偏差，
// 不会退化成"三种下载共用一个选择器"。
assert.ok(
  matchDownloadSelector(x64Sel, pageHrefs[0]),
  'the x64 selector must match the x64 link, got: ' + x64Sel
);
// 扩展名保底：.dmg 不能混进 .exe 的选择器。
assert.ok(
  !matchDownloadSelector(arm64Sel, pageHrefs[2]),
  'the .exe selector must not match a .dmg link'
);

// 版本升级鲁棒性：架构保留的同时，版本号变化必须让选择器保持完全不变。
const bumpCases = [
  ['WeChatSetup_4.0.6.19.exe', 'WeChatSetup_4.0.9.2.exe'],
  ['WeChatSetup_4.0.6.19_arm64.exe', 'WeChatSetup_5.1.0_arm64.exe'],
  ['putty-64-bit-3.505.exe', 'putty-64-bit-4.0.exe'],
  ['putty-32-bit-3.505.exe', 'putty-32-bit-4.0.exe'],
  ['Node-v20.11.0-win-x64.zip', 'Node-v22.3.0-win-x64.zip'],
  ['python-3.12.1-amd64.exe', 'python-3.13.0-amd64.exe'],
];
for (const [oldName, newName] of bumpCases) {
  const a = buildSelector(anchor('https://x.test/' + oldName));
  const b = buildSelector(anchor('https://x.test/' + newName));
  assert.equal(a, b, 'a version bump must not invalidate the selector for ' + oldName);
}
// 32 位 / 64 位必须区分开（位数段不能被当成版本号剥掉）。
assert.notEqual(
  buildSelector(anchor('https://x.test/putty-64-bit-3.505.exe')),
  buildSelector(anchor('https://x.test/putty-32-bit-3.505.exe')),
  'the bit-width segment must survive version stripping'
);
// head 必须取原串的连续切片：putty-64 的段不能被拼成 "putty64" 而失配。
assert.ok(
  matchDownloadSelector(
    buildSelector(anchor('https://x.test/putty-64-bit-3.505.exe')),
    'https://x.test/putty-64-bit-3.505.exe'
  ),
  'a reassembled (non-contiguous) hint would not match the real href'
);

// picker.js 与 offscreen.js 各有一份 downloadSelectorParts：首次拾取用前者，
// 选择器自愈用后者。两份实现一旦漂移，同一条监控在"新建"和"自愈"时会拿到
// 不同的选择器，自愈就会把链接指到别处。这里直接比对标记表的字面量。
const pickerSource = fs.readFileSync(path.join(__dirname, '..', 'picker.js'), 'utf8');
const qualifierOf = (src) => (src.match(/QUALIFIER_TOKEN\s*=\s*(\/.*?\/i);/) || [])[1];
assert.ok(qualifierOf(source), 'offscreen.js must define QUALIFIER_TOKEN');
assert.equal(
  qualifierOf(pickerSource),
  qualifierOf(source),
  'picker.js and offscreen.js must keep the same QUALIFIER_TOKEN (selector drift)'
);

// 同样要防 SITE_MARKS / DOWNLOAD_EXT 漂移。
// SITE_MARKS 允许 picker 多几个：wxqcloud 只能靠主机名识别，picker 有 a.href 绝对地址，
// offscreen.js 没有 baseURL 取不到。所以这里断言的是**包含关系**而不是相等 ——
// offscreen 有的每个标记 picker 都必须有，否则同一个链接在"首次拾取"和"自愈"
// 两处会拿到不同的选择器。
const literalListOf = (src, name) => {
  const m = src.match(new RegExp(name + '\\s*=\\s*\\[([^\\]]*)\\]'));
  if (!m) return null;
  return m[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
};
const siteOf = literalListOf(source, 'SITE_MARKS');
const pickerSite = literalListOf(pickerSource, 'SITE_MARKS');
assert.ok(siteOf && pickerSite, 'both files must define SITE_MARKS');
assert.deepEqual(
  siteOf,
  siteOf.filter((m) => pickerSite.includes(m)),
  'every SITE_MARKS entry in offscreen.js must also exist in picker.js (selector drift)'
);
const extOf = (src) => (src.match(/DOWNLOAD_EXT\s*=\s*(\/\^.*?\/i);/) || [])[1];
assert.ok(extOf(source), 'offscreen.js must define DOWNLOAD_EXT');
assert.equal(
  extOf(pickerSource),
  extOf(source),
  'picker.js and offscreen.js must keep the same DOWNLOAD_EXT (selector drift)'
);

console.log('offscreen-review tests passed');
