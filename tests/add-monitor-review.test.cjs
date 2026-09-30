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
  // 真实 DOM 里 `listEl.innerHTML = ''` 会丢掉所有子节点。桩若只把它当普通
  // 字段，旧节点会一直留在 children 里，测试就会读到上一轮的残留 —— 正好把
  // 本该被发现的"陈旧反馈复活"bug 藏起来。这里按真实语义清空。
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    set(v) { _html = v; el.children.length = 0; },
    enumerable: true,
  });
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

  // ---------------- mergeImportedMonitors：页面侧导入兜底 ----------------
  // 页面兜底（无法与 background 通信时直写）此前用 map.set 整体替换，既不保留
  // 本机 id、也不去重 id，与 background 主路径行为不一致。
  // 1) 命中已有 key 时必须保留本机 id —— id 是 alarm 名 / 通知 id / 检查锁的键。
  const localMon = { id: 'local-1', url: 'https://example.test/h', type: 'page', interval: 30, name: '本机' };
  const fromBackup = context.normalizeImportedMonitor({
    id: 'backup-9', url: 'https://example.test/h', type: 'page', interval: 60, name: '备份',
  });
  const r1 = context.mergeImportedMonitors([localMon], [fromBackup]);
  assert.equal(r1.added, 0, 'an already-known key must not count as added');
  assert.equal(r1.merged.length, 1, 'an already-known key must merge, not duplicate');
  assert.equal(
    r1.merged[0].id, 'local-1',
    'importing over an existing monitor must keep this machine id'
  );
  assert.equal(
    r1.merged[0].interval, 60,
    'the imported fields must still be applied to the merged monitor'
  );

  // 2) 备份里的 id 未必和本机其它监控不冲突：必须重新发号，而不是撞 id。
  //    id 重复会让两条监控共用一个 alarm（其中一条再也不会被检查）、共用同一个
  //    通知 id，且 findIndex(m.id === ...) 永远只命中第一条。
  const clash = [
    { id: 'dup', url: 'https://example.test/i', type: 'page', interval: 30 },
    { id: 'dup', url: 'https://example.test/j', type: 'page', interval: 30 },
  ];
  const r2 = context.mergeImportedMonitors(clash, []);
  const ids = r2.merged.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'monitor ids must be unique after a merge');
  assert.notEqual(r2.merged[1].id, 'dup', 'the duplicate id must be re-minted');
  assert.equal(
    r2.merged[1].url, 'https://example.test/j',
    're-minting must not disturb the monitor payload'
  );

  // 3) 空 id 也必须补发 —— 空的 id 会让 alarm 名退化成前缀本身。
  const r3 = context.mergeImportedMonitors([{ id: '', url: 'https://example.test/k', type: 'page' }], []);
  assert.ok(r3.merged[0].id, 'a monitor with an empty id must be given a fresh id');

  console.log('add-monitor-review tests passed');
}

// ---------------------------------------------------------------------------
// checkNow 的结果反馈必须在 renderList() 全量重建之后仍然可见。
// renderList 会 listEl.innerHTML='' 再重建每一行，若反馈只写进旧节点，
// 下一轮重建会连同节点一起删掉 —— 用户刚点"立即检查"就看不到任何结果。
// 这里用一个 getElementById 会重复返回同一实例的 DOM 桩跑完整流程。
// ---------------------------------------------------------------------------
function testCheckNowFeedbackSurvivesRender() {
  const byId = new Map();
  const realMakeEl = makeEl;
  const doc = {
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, realMakeEl(id));
      return byId.get(id);
    },
    createElement: (tag) => realMakeEl(tag),
    querySelector: () => realMakeEl('sel'),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: realMakeEl('body'),
    documentElement: realMakeEl('html'),
  };

  // 监控 m1 已存在；check-now 返回 changed，走"渲染 + 反馈"这条最典型的路径。
  const monitors = [{ id: 'm1', url: 'https://example.test/a', type: 'page', interval: 30 }];
  const syncGet = async (key) => (key === 'monitors' ? { monitors } : {});

  const ctx2 = vm.createContext({
    chrome: {
      runtime: {
        id: 'test',
        getManifest: () => ({ version: '0.0.0-test' }),
        getURL: (p) => 'chrome-extension://test/' + p,
        sendMessage: async (msg) => {
          if (msg && msg.type === 'check-now') return { ok: true, result: 'changed' };
          return { ok: true };
        },
        lastError: null,
      },
      storage: {
        sync: { get: syncGet, set: async () => {}, remove: async () => {} },
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      },
      tabs: { query: async () => [], sendMessage: async () => {}, create: () => {} },
      scripting: { executeScript: async () => [] },
      alarms: { create: () => {}, clear: async () => true, get: async () => null },
      notifications: { create: () => {}, clear: async () => true },
    },
    console,
    document: doc,
    window: { addEventListener() {}, removeEventListener() {}, location: { href: 'https://example.test/' } },
    location: { href: 'https://example.test/' },
    navigator: { clipboard: null, userAgent: 'node' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URL, JSON, Date, Math, Number, String, Object, Array, Set, Map, Promise,
    setTimeout: () => 0,
    clearTimeout: () => {},
    confirm: () => false,
    alert: () => {},
  });
  ctx2.globalThis = ctx2;
  vm.runInContext(source, ctx2, { filename: 'add-monitor.js' });

  return (async () => {
    const listEl = doc.getElementById('monitor-list');
    const btn = makeEl('btn');
    const feedback = makeEl('feedback');
    // await 到 checkNow 结束：此时 renderList 已跑完，DOM 里是重建后的新节点。
    await ctx2.checkNow('m1', btn, feedback);

    // 找到重建后那一行的 feedback 节点。
    const row = listEl.children[0];
    assert.ok(row, 'renderList must have rebuilt the monitor row');
    const info = row.children[0];
    const rebuilt = info.children.find(
      (c) => typeof c.className === 'string' && c.className.indexOf('watcher-feedback') !== -1
    );
    assert.ok(rebuilt, 'the rebuilt row must still contain a feedback element');
    assert.equal(
      rebuilt.textContent, '检测到变化，已发送通知 ✓',
      'check-now result must survive the renderList rebuild'
    );
    assert.ok(
      !(typeof rebuilt.classList.contains === 'function' && rebuilt.classList.contains('hidden')),
      'the rebuilt feedback must be visible'
    );
    console.log('add-monitor checkNow feedback tests passed');
  })();
}

// ---------------------------------------------------------------------------
// 反馈贴回之后必须立刻被消费掉。v0.6.41 为了躲开 renderList 的竞态，没有清空
// pendingCheckFeedback，于是这个标记永远残留：用户做过一次检查之后，之后任何
// 无关的 renderList()（编辑、删除、测试面板、init 首屏）都会把那条旧反馈
// 重新贴回 —— 例如编辑完某条监控，N 分钟前的「未找到目标」又冒出来了。
// 这里跑"检查 → 无关重建"两步，断言旧反馈不会复活。
// ---------------------------------------------------------------------------
function testStaleFeedbackDoesNotResurrect() {
  const byId = new Map();
  const realMakeEl = makeEl;
  const doc = {
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, realMakeEl(id));
      return byId.get(id);
    },
    createElement: (tag) => realMakeEl(tag),
    querySelector: () => realMakeEl('sel'),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: realMakeEl('body'),
    documentElement: realMakeEl('html'),
  };

  const monitors = [{ id: 'm1', url: 'https://example.test/a', type: 'page', interval: 30 }];
  const syncGet = async (key) => (key === 'monitors' ? { monitors } : {});

  const ctx2 = vm.createContext({
    chrome: {
      runtime: {
        id: 'test',
        getManifest: () => ({ version: '0.0.0-test' }),
        getURL: (p) => 'chrome-extension://test/' + p,
        sendMessage: async (msg) => {
          if (msg && msg.type === 'check-now') return { ok: true, result: 'changed' };
          return { ok: true };
        },
        lastError: null,
      },
      storage: {
        sync: { get: syncGet, set: async () => {}, remove: async () => {} },
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      },
      tabs: { query: async () => [], sendMessage: async () => {}, create: () => {} },
      scripting: { executeScript: async () => [] },
      alarms: { create: () => {}, clear: async () => true, get: async () => null },
      notifications: { create: () => {}, clear: async () => true },
    },
    console,
    document: doc,
    window: { addEventListener() {}, removeEventListener() {}, location: { href: 'https://example.test/' } },
    location: { href: 'https://example.test/' },
    navigator: { clipboard: null, userAgent: 'node' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URL, JSON, Date, Math, Number, String, Object, Array, Set, Map, Promise,
    setTimeout: () => 0,
    clearTimeout: () => {},
    confirm: () => false,
    alert: () => {},
  });
  ctx2.globalThis = ctx2;
  vm.runInContext(source, ctx2, { filename: 'add-monitor.js' });

  const listEl = doc.getElementById('monitor-list');
  const readFeedback = () => {
    const row = listEl.children[0];
    if (!row) return null;
    const info = row.children[0];
    if (!info) return null;
    return Array.from(info.children).find(
      (c) => c && typeof c.className === 'string' && c.className.indexOf('watcher-feedback') !== -1
    ) || null;
  };

  return (async () => {
    // 第一次：跑完一次 checkNow，反馈应当可见。
    await ctx2.checkNow('m1', realMakeEl('btn'), realMakeEl('feedback'));
    const first = readFeedback();
    assert.ok(first, 'the feedback element must exist after the first render');
    assert.equal(first.textContent, '检测到变化，已发送通知 ✓', 'first render must show the feedback');

    // 第二次重建：模拟用户编辑/删除/打开测试面板触发的无关 renderList()。
    await ctx2.renderList();
    const second = readFeedback();
    assert.ok(second, 'the feedback element must exist after the second render');
    assert.equal(
      second.textContent, '',
      'stale check feedback must not resurrect on an unrelated render'
    );
    console.log('add-monitor stale feedback tests passed');
  })();
}

test();
testCheckNowFeedbackSurvivesRender()
  .then(testStaleFeedbackDoesNotResurrect)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
