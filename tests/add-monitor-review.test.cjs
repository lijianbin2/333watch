const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// add-monitor.js 是弹窗页面脚本：顶层直接抓 DOM、注册事件监听、跑 init()。
// 这里用最小 DOM 桩把它整个跑起来，只为能直接调用它的纯函数
// （normalizeImportedMonitor / monitorKey / clampInterval / limitMonitorValue），
// 这些函数决定"导入的备份会不会被静默丢弃"。
const source = fs.readFileSync(path.join(__dirname, '..', 'add-monitor.js'), 'utf8');

function makeEl(id) {
  const el = {
    id,
    tagName: 'DIV',
    value: '',
    textContent: '',
    title: '',
    href: '',
    type: '',
    className: '',
    checked: false,
    disabled: false,
    innerHTML: '',
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    append() {},
    prepend() {},
    remove() {},
    insertBefore(a) { return a; },
    querySelector() { return makeEl('q'); },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    contains() { return false; },
    closest() { return null; },
    focus() {},
    click() {},
    select() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return el;
}

const localStore = new Map();
const chrome = {
  runtime: {
    id: 'test',
    getManifest: () => ({ version: '0.0.0-test' }),
    getURL: (p) => 'chrome-extension://test/' + p,
    sendMessage: async () => ({ ok: false }),
    lastError: null,
  },
  storage: {
    sync: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
  },
  tabs: { query: async () => [], sendMessage: async () => {}, create: () => {} },
  scripting: { executeScript: async () => [] },
  alarms: { create: () => {}, clear: async () => true, get: async () => null },
  notifications: { create: () => {}, clear: async () => true },
};

const context = vm.createContext({
  chrome,
  console,
  document: {
    getElementById: (id) => makeEl(id),
    createElement: (tag) => makeEl(tag),
    querySelector: () => makeEl('sel'),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: makeEl('body'),
    documentElement: makeEl('html'),
  },
  window: { addEventListener() {}, removeEventListener() {}, location: { href: 'https://example.test/' } },
  location: { href: 'https://example.test/' },
  navigator: { clipboard: null, userAgent: 'node' },
  localStorage: {
    getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
    setItem: (k, v) => localStore.set(k, String(v)),
    removeItem: (k) => localStore.delete(k),
  },
  URL,
  JSON,
  Date,
  Math,
  Number,
  String,
  Object,
  Array,
  Set,
  Map,
  Promise,
  setTimeout: () => 0,
  clearTimeout: () => {},
  confirm: () => false,
  alert: () => {},
});
context.globalThis = context;
vm.runInContext(source, context, { filename: 'add-monitor.js' });

function test() {
  assert.equal(typeof context.normalizeImportedMonitor, 'function');

  // 普通页面监控：原样导入。
  const page = context.normalizeImportedMonitor({
    id: 'p1', url: 'https://example.test/a/', type: 'page', interval: 30, name: 'A',
  });
  assert.equal(page.url, 'https://example.test/a', 'trailing slashes must be trimmed');
  assert.equal(page.type, 'page');
  assert.equal(page.interval, 30);

  // 指定内容监控：带 selector 时正常导入。
  const el = context.normalizeImportedMonitor({
    id: 'e1', url: 'https://example.test/b', type: 'element',
    selector: '#dl', attribute: 'href', lastValue: 'https://example.test/old.zip',
  });
  assert.equal(el.type, 'element');
  assert.equal(el.attribute, 'href');
  assert.equal(el.selector, '#dl');
  assert.equal(el.lastValue, 'https://example.test/old.zip');

  // 旧版链接监控没有 selector，只有 targetHref/targetText。
  // background 的 migrateData 与 checkMonitor 都会为这种记录走 checkLink 回退路径，
  // 导入时若把它当无效项丢弃，用户备份里的监控就静默消失了。
  const legacyLink = context.normalizeImportedMonitor({
    id: 'l1', url: 'https://example.test/c', type: 'element', attribute: 'href',
    selector: '', targetHref: 'https://example.test/legacy.zip', targetText: '下载',
    lastValue: 'https://example.test/legacy.zip',
  });
  assert.ok(legacyLink, 'a legacy link monitor without a selector must still be imported');
  assert.equal(legacyLink.type, 'element');
  assert.equal(legacyLink.attribute, 'href');
  assert.equal(legacyLink.targetHref, 'https://example.test/legacy.zip', 'targetHref must survive the import');
  assert.equal(legacyLink.targetText, '下载', 'targetText must survive the import');

  // 更老的 type:"download" / type:"link" 记录也必须被接住。
  const oldDownload = context.normalizeImportedMonitor({
    id: 'd1', url: 'https://example.test/d', type: 'download',
    targetHref: 'https://example.test/old.zip',
  });
  assert.ok(oldDownload, 'a legacy type=download monitor must still be imported');
  assert.equal(oldDownload.type, 'element');
  assert.equal(oldDownload.attribute, 'href');
  assert.equal(oldDownload.targetHref, 'https://example.test/old.zip');

  // eventSeq 必须保留：它是跨设备去重 eventKey 的一部分，重置成 0 会让
  // 新导入的监控与历史里的旧事件撞上同一个 eventKey。
  const withSeq = context.normalizeImportedMonitor({
    id: 's1', url: 'https://example.test/e', type: 'page', eventSeq: 12,
  });
  assert.equal(withSeq.eventSeq, 12, 'eventSeq must be preserved on import');

  // interval 必须被夹紧，防止备份里的异常值建出永不触发的 alarm。
  assert.equal(context.normalizeImportedMonitor({ url: 'https://x.test/', interval: 0 }).interval, 500);
  assert.equal(context.normalizeImportedMonitor({ url: 'https://x.test/', interval: 1e9 }).interval, 10080);
  assert.equal(context.normalizeImportedMonitor({ url: 'https://x.test/', interval: -5 }).interval, 500);

  // 无 url / 非对象的记录必须被拒。
  assert.equal(context.normalizeImportedMonitor(null), null);
  assert.equal(context.normalizeImportedMonitor('nope'), null);
  assert.equal(context.normalizeImportedMonitor({ url: '   ' }), null);

  // 指定内容监控缺 selector 且没有任何回退目标时，才算无效。
  assert.equal(
    context.normalizeImportedMonitor({ url: 'https://x.test/', type: 'element', selector: '' }),
    null,
    'an element monitor with neither selector nor link target is unusable'
  );

  // ---------------- monitorKey：旧版链接监控不能互相吞掉 ----------------
  // 旧版链接监控没有 selector，区分目标靠 targetHref/targetText。
  // 旧实现的 key 只用 url + selector + attribute，同一页面上两条指向不同
  // 下载地址的旧链接监控 key 完全相同：导入时 map.set 后者覆盖前者，
  // 用户备份里明明有两条，导入后凭空少一条。
  const legacyA = context.normalizeImportedMonitor({
    url: 'https://example.test/f', type: 'element', attribute: 'href',
    targetHref: 'https://example.test/win.zip',
  });
  const legacyB = context.normalizeImportedMonitor({
    url: 'https://example.test/f', type: 'element', attribute: 'href',
    targetHref: 'https://example.test/mac.zip',
  });
  assert.notEqual(
    context.monitorKey(legacyA),
    context.monitorKey(legacyB),
    'two legacy link monitors with different targetHref must not share a key'
  );
  // 仅靠 targetText 区分的旧记录同样不能撞 key。
  const byTextA = context.normalizeImportedMonitor({
    url: 'https://example.test/g', type: 'element', attribute: 'text',
    targetText: 'Win',
  });
  const byTextB = context.normalizeImportedMonitor({
    url: 'https://example.test/g', type: 'element', attribute: 'text',
    targetText: 'Mac',
  });
  assert.notEqual(
    context.monitorKey(byTextA),
    context.monitorKey(byTextB),
    'two legacy monitors with different targetText must not share a key'
  );
  // 同一条监控重复导入仍必须命中同一个 key（去重语义不能被破坏）。
  assert.equal(
    context.monitorKey(legacyA),
    context.monitorKey(context.normalizeImportedMonitor({
      url: 'https://example.test/f/', type: 'element', attribute: 'href',
      targetHref: 'https://example.test/win.zip',
    })),
    'the same legacy monitor must keep a stable key across imports'
  );
  // 带 selector 的常规监控 key 保持原样。
  assert.equal(
    context.monitorKey(el),
    'element|https://example.test/b|#dl|href',
    'selector-based monitors must keep their existing key shape'
  );

  console.log('add-monitor-review tests passed');
}

test();
