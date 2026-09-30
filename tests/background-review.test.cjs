const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backgroundPath = path.join(__dirname, '..', 'background.js');
const source = fs.readFileSync(backgroundPath, 'utf8');
const listeners = { runtime: [], notifications: [], storage: [], alarms: [] };
const syncStore = new Map();
const localStore = new Map();
let notificationCount = 0;
// offscreen 文档的生命周期状态：用于验证"查询失败也必须关闭"。
let offscreenOpen = false;
// 结构化克隆：真实 chrome.storage 读出的是副本，读写不共享引用。
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------------- 虚拟时钟 ----------------
// 跨设备认领仲裁是"在窗口内反复轮询存储"，必须能确定性地推进时间：
// 若 setTimeout 立即执行，窗口永远走不到头，测试会死循环；
// 若用真实定时器，5 秒窗口会把单测拖得很慢。这里改成虚拟时钟 +
// setImmediate 驱动的时钟泵：到点的定时器立刻按（到期时间, 序号）顺序执行。
let vNow = Date.now();
let vTimerSeq = 0;
const vTimers = new Map();
const fakeSetTimeout = (fn, ms) => {
  const id = ++vTimerSeq;
  vTimers.set(id, { at: vNow + (Number(ms) || 0), fn });
  return id;
};
const fakeClearTimeout = (id) => { vTimers.delete(id); };
class VirtualDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(vNow);
    else super(...args);
  }
  static now() { return vNow; }
}

let clockRunning = false;
function pumpOneTimer() {
  let nextId = null;
  for (const [id, timer] of vTimers) {
    if (nextId === null || timer.at < vTimers.get(nextId).at) nextId = id;
  }
  if (nextId === null) return false;
  const timer = vTimers.get(nextId);
  vTimers.delete(nextId);
  if (timer.at > vNow) vNow = timer.at;
  timer.fn();
  return true;
}
function startClock() {
  if (clockRunning) return;
  clockRunning = true;
  const step = () => {
    if (!clockRunning) return;
    pumpOneTimer();
    setImmediate(step);
  };
  setImmediate(step);
}
function stopClock() { clockRunning = false; }

const chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => listeners.runtime.push(fn) },
    onInstalled: { addListener: (fn) => listeners.runtime.push(fn) },
    onStartup: { addListener: (fn) => listeners.runtime.push(fn) },
    sendMessage: async () => ({ ok: false }),
  },
  offscreen: {
    hasDocument: async () => offscreenOpen,
    createDocument: async () => { offscreenOpen = true; },
    closeDocument: async () => { offscreenOpen = false; },
  },
  notifications: {
    onClicked: { addListener: (fn) => listeners.notifications.push(fn) },
    create: (_id, _options, callback) => { notificationCount += 1; callback('test-notification'); },
    clear: async () => true,
  },
  storage: {
    sync: {
      get: async (key) => {
        if (key == null) return Object.fromEntries([...syncStore].map(([k, v]) => [k, clone(v)]));
        if (Array.isArray(key)) {
          return Object.fromEntries(key.filter((k) => syncStore.has(k)).map((k) => [k, clone(syncStore.get(k))]));
        }
        return syncStore.has(key) ? { [key]: clone(syncStore.get(key)) } : {};
      },
      set: async (values) => Object.entries(values).forEach(([key, value]) => syncStore.set(key, clone(value))),
      remove: async (key) => {
        for (const name of Array.isArray(key) ? key : [key]) syncStore.delete(name);
      },
    },
    local: {
      get: async (key) => {
        if (key == null) return Object.fromEntries([...localStore].map(([k, v]) => [k, clone(v)]));
        if (Array.isArray(key)) {
          return Object.fromEntries(key.filter((k) => localStore.has(k)).map((k) => [k, clone(localStore.get(k))]));
        }
        return localStore.has(key) ? { [key]: clone(localStore.get(key)) } : {};
      },
      set: async (values) => Object.entries(values).forEach(([key, value]) => localStore.set(key, clone(value))),
      remove: async (key) => {
        for (const name of Array.isArray(key) ? key : [key]) localStore.delete(name);
      },
    },
    onChanged: { addListener: (fn) => listeners.storage.push(fn) },
  },
  action: {
    setBadgeBackgroundColor: async () => {},
    setBadgeText: async () => {},
  },
  alarms: {
    onAlarm: { addListener: (fn) => listeners.alarms.push(fn) },
    getAll: async () => [],
    get: async () => null,
    create: () => {},
    clear: async () => true,
  },
};

const context = vm.createContext({
  chrome,
  console,
  fetch: async () => { throw new Error('network disabled in unit test'); },
  AbortController,
  TextEncoder,
  TextDecoder,
  URL,
  Date: VirtualDate,
  Set,
  Map,
  Number,
  String,
  Math,
  JSON,
  Array,
  Object,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
});
vm.runInContext(source, context, { filename: backgroundPath });

// 测试用 fetch 注入点：让端到端用例可以控制抓取结果。
let currentFetch = async () => { throw new Error('network disabled in unit test'); };
context.fetch = (...args) => currentFetch(...args);
context.__setFetch = (fn) => { currentFetch = fn; };

// 派发一条 runtime 消息，返回 sendResponse 的结果。
function sendMessage(msg) {
  const handler = listeners.runtime[0];
  assert.equal(typeof handler, 'function', 'background must register an onMessage listener');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no response for ' + msg.type)), 2000);
    const keep = handler(msg, {}, (res) => { clearTimeout(timer); resolve(res); });
    if (keep !== true) { clearTimeout(timer); resolve(undefined); }
  });
}

async function test() {
  // 启动虚拟时钟泵：后台的定时器（仲裁窗口轮询、节流、补检）才会按预期推进。
  startClock();
  assert.equal(context.nextEventSequence(undefined), 1);
  assert.equal(context.nextEventSequence(0), 1);
  assert.equal(context.nextEventSequence('7'), 8);
  assert.equal(context.nextEventSequence(2147483647), 2147483647);
  assert.equal(context.nextEventSequence(-1), 1);

  const oldHtml = '<html><body>A</body></html>';
  const newHtml = '<html><body>B</body></html>';
  const monitor = { id: 'page-1', url: 'https://example.test/', type: 'page', lastHash: null };
  const baseline = await context.checkPage(monitor, oldHtml);
  assert.equal(baseline.changed, false);
  assert.equal(baseline.prevValue, null);
  monitor.lastHash = baseline.update.lastHash;
  const changed = await context.checkPage(monitor, newHtml);
  assert.equal(changed.changed, true);
  assert.equal(changed.prevValue, baseline.update.lastHash);

  // ---------------- extractLinks：链接监控的取值基础 ----------------
  // 旧实现用 /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1.../ 匹配，有两个真实缺陷：
  //
  // 1) `[^>]*?href` 没有属性边界，`<a data-href="/fake.exe" href="/real.exe">`
  //    会先匹配到 data-href 的值，于是链接监控盯在错误地址上 —— 真实 href 变化时
  //    不报，data-href 变化时反而误报。下载页用 data-href 非常普遍。
  // 2) 只认带引号的属性值，`<a href=/x.exe>` 这种合法写法整个被跳过，
  //    链接监控会误报"页面已无此链接目标"并最终把监控标记为失效。
  const linkBase = 'https://dl.test/page';
  // 注意：background.js 在 vm realm 里执行，它返回的数组原型不是宿主的 Array，
  // 直接 deepStrictEqual 会因原型不同而误报。这里用 Array.from 换回宿主数组。
  const linksOf = (html) => Array.from(context.extractLinks(html, linkBase), (l) => l.href);
  assert.deepEqual(
    linksOf('<a class="btn" data-href="/dl/fake.exe" href="/dl/real.exe">Download</a>'),
    ['https://dl.test/dl/real.exe'],
    'data-href must not shadow the real href attribute'
  );
  assert.deepEqual(
    linksOf('<a href=/dl/unquoted.exe>Unquoted</a>'),
    ['https://dl.test/dl/unquoted.exe'],
    'an unquoted href value must still be extracted'
  );
  assert.deepEqual(
    linksOf('<a title="a > b" href="/dl/gt.exe">GT</a>'),
    ['https://dl.test/dl/gt.exe'],
    'a ">" inside a quoted attribute must not truncate the tag'
  );
  assert.deepEqual(
    linksOf('<a HREF="/dl/upper.exe">Upper</a>'),
    ['https://dl.test/dl/upper.exe'],
    'href must stay case-insensitive'
  );
  assert.deepEqual(
    linksOf('<a href="  /dl/trim.exe  ">Trim</a>'),
    ['https://dl.test/dl/trim.exe'],
    'surrounding whitespace in the href must be trimmed'
  );
  // 无引号属性值不能吞掉后面的标签：<a href=/x.exe><b>Text</b></a>
  assert.deepEqual(
    linksOf('<a href=/dl/plain2.exe><b>Plain2</b></a>'),
    ['https://dl.test/dl/plain2.exe'],
    'an unquoted href must stop at whitespace, not swallow following attributes'
  );
  // 非 http(s) 协议仍然要跳过。
  assert.deepEqual(
    linksOf('<a href="javascript:void(0)">x</a><a href="#top">y</a><a href="mailto:a@b.c">z</a>'),
    [],
    'javascript/hash/mailto links must stay filtered out'
  );
  // 文本内容仍要正确抽取（供 targetText 匹配使用）。
  assert.equal(
    context.extractLinks('<a href="/dl/t.exe"><span>Windows</span> 版</a>', linkBase)[0].text,
    'Windows 版',
    'link text must be stripped of tags and whitespace-normalised'
  );

  // ---------------- extractLinks：HTML 实体必须解码 ----------------
  // picker 存基线读的是真实 DOM（textContent 已解码、a.href 已被 URL 解析），
  // 而 extractLinks 只能正则解析源码，实体是源码形态 `&amp;`。
  // 两侧形态不一致 → targetText / targetHref 永远匹配不上 →
  // 监控误报"页面已无此链接目标"并被标记为失效。
  // 下载/文档站点的链接文本里 `&` 极常见（AT&T、C++ & Go）。
  assert.equal(
    context.extractLinks('<a href="/dl/t.exe">AT&amp;T 下载</a>', linkBase)[0].text,
    'AT&T 下载',
    'named entities in link text must be decoded to match the DOM textContent'
  );
  assert.equal(
    context.extractLinks('<a href="/dl/t.exe">Bob&#39;s Tools</a>', linkBase)[0].text,
    "Bob's Tools",
    'decimal numeric character references must be decoded'
  );
  assert.equal(
    context.extractLinks('<a href="/dl/t.exe">Caf&#xe9; &amp; Bar</a>', linkBase)[0].text,
    'Café & Bar',
    'hexadecimal character references must be decoded'
  );
  // href 里的实体必须在 new URL 之前解码，否则地址本身就带着 &amp;。
  assert.deepEqual(
    linksOf('<a href="/dl/q.exe?a=1&amp;b=2">Q</a>'),
    ['https://dl.test/dl/q.exe?a=1&b=2'],
    'entities in an href must be decoded before URL resolution'
  );
  // 双重编码只能解一层。
  assert.equal(
    context.extractLinks('<a href="/dl/t.exe">&amp;amp;</a>', linkBase)[0].text,
    '&amp;',
    'a doubly-encoded entity must only be decoded once'
  );
  // 无分号的裸 & 保持原样（HTML 允许），不能被误吞。
  assert.equal(
    context.extractLinks('<a href="/dl/t.exe">A&B</a>', linkBase)[0].text,
    'A&B',
    'a bare ampersand without a semicolon must survive untouched'
  );
  // 未知实体保留原样，不能变成空串。
  assert.equal(
    context.extractLinks('<a href="/dl/t.exe">&notarealentity;</a>', linkBase)[0].text,
    '&notarealentity;',
    'an unknown entity must be left as-is rather than dropped'
  );
  // 非法/越界码点不能解码成 U+FFFD 替换字符。
  assert.equal(
    context.extractLinks('<a href="/dl/t.exe">&#x110000;x</a>', linkBase)[0].text,
    '&#x110000;x',
    'an out-of-range code point must not become a replacement character'
  );

  const eventBase = {
    id: 'page-1',
    url: 'https://example.test/',
    type: 'page',
    eventSeq: 1,
  };
  const first = context.buildNotificationEvent(eventBase, 'change', 'changed', {
    oldValue: 'a', newValue: 'b', sequence: 1,
  });
  const same = context.buildNotificationEvent(eventBase, 'change', 'changed', {
    oldValue: 'a', newValue: 'b', sequence: 1,
  });
  const next = context.buildNotificationEvent({ ...eventBase, eventSeq: 2 }, 'change', 'changed', {
    oldValue: 'a', newValue: 'b', sequence: 2,
  });
  assert.equal(first.eventKey, same.eventKey);
  assert.notEqual(first.eventKey, next.eventKey);

  // 基线已被其他设备推进过时，本次检测不得再触发通知。
  const stored = { type: 'page', lastHash: 'hash-from-other-device' };
  assert.equal(
    context.baselineSuperseded({ changed: true, baseValue: 'old-hash', baseField: 'lastHash' }, stored),
    true,
    'a superseded baseline must suppress the notification'
  );
  assert.equal(
    context.baselineSuperseded({ changed: true, baseValue: 'hash-from-other-device', baseField: 'lastHash' }, stored),
    false,
    'a matching baseline must remain notifyable'
  );
  assert.equal(
    context.baselineSuperseded({ changed: false, baseValue: 'old', baseField: 'lastValue' }, { type: 'element', lastValue: 'other' }),
    false,
    'an unchanged result is never superseded'
  );
  assert.equal(
    context.baselineSuperseded({ changed: true, baseValue: null, baseField: 'lastValue' }, { type: 'element', lastValue: null }),
    false,
    'both baselines unset must match'
  );

  // 被抢先记录时不得用本次抓取值覆盖存储基线，否则更新的变化会被吞掉。
  const supersededUpdate = context.updateWithoutSupersededBaseline(
    { baseField: 'lastValue', update: { lastValue: 'newer', selector: '#a' } },
    { type: 'element', lastValue: 'stored' }
  );
  assert.equal(supersededUpdate.lastValue, undefined, 'a superseded baseline must not overwrite the stored value');
  assert.equal(supersededUpdate.selector, '#a', 'unrelated update fields must be preserved');
  const pageUpdate = context.updateWithoutSupersededBaseline(
    { baseField: 'lastHash', update: { lastHash: 'hash2' } },
    { type: 'page', lastHash: 'hash1' }
  );
  assert.equal(pageUpdate.lastHash, undefined, 'page baselines must also be preserved when superseded');

  // 认领仲裁：多条同 eventKey 的并发认领必须选出同一个赢家。
  const nowMs = Date.now();
  const claimA = { id: 'aaa', eventKey: 'k1', claimAt: nowMs, pending: true };
  const claimB = { id: 'bbb', eventKey: 'k1', claimAt: nowMs + 1000, pending: true };
  const claimC = { id: 'ccc', eventKey: 'k1', claimAt: nowMs, pending: true };
  assert.equal(context.pickClaimWinner([claimB, claimA]).id, 'aaa', 'the earliest claim wins');
  assert.equal(
    context.pickClaimWinner([claimA, claimB]).id,
    context.pickClaimWinner([claimB, claimA]).id,
    'arbitration must not depend on array order'
  );
  assert.equal(
    context.pickClaimWinner([claimA, claimC]).id,
    'aaa',
    'a claimAt tie must be broken deterministically by id'
  );
  assert.deepEqual(
    context.rivalClaimsOf({ eventKey: 'k1' }, [claimA, claimB, { id: 'x', eventKey: 'k2', pending: true }], 'aaa').map((h) => h.id),
    ['bbb'],
    'rivals must exclude the own claim and other event keys'
  );
  assert.deepEqual(
    context.rivalClaimsOf({ eventKey: 'k1' }, [claimA, { id: 'old', eventKey: 'k1', claimAt: nowMs - 10 * 60 * 1000, pending: true }], 'aaa'),
    [],
    'an expired rival claim must not win arbitration'
  );

  syncStore.clear();
  syncStore.set('history', [{ url: eventBase.url, message: first.message, read: true }]);
  assert.equal(context.hasSeenEvent(first, syncStore.get('history')), true, 'legacy read history should suppress a matching event');
  syncStore.set('history', [{ url: eventBase.url, message: first.message, eventKey: first.eventKey, read: true }]);
  assert.equal(context.hasSeenEvent(first, syncStore.get('history')), true, 'read event key should suppress the same event');
  assert.equal(context.hasSeenEvent(next, syncStore.get('history')), false, 'a new sequence must remain notifyable');

  syncStore.clear();
  notificationCount = 0;
  const notifyRecord = { name: 'page-1', url: eventBase.url, message: first.message, kind: 'change' };
  const firstNotify = await context.notifyOnce(first, notifyRecord, 'notif-page-1', '333 Watcher');
  assert.equal(firstNotify.ok, true);
  assert.equal(firstNotify.notificationId, 'test-notification');
  assert.equal(notificationCount, 1);
  const secondNotify = await context.notifyOnce(first, notifyRecord, 'notif-page-1', '333 Watcher');
  assert.equal(secondNotify.ok, true);
  assert.equal(secondNotify.skipped, true);
  assert.equal(notificationCount, 1, 'the same event must not notify twice in one profile');

  syncStore.set('history', [{
    id: 'other-device-claim',
    url: eventBase.url,
    message: first.message,
    eventKey: first.eventKey,
    claimAt: Date.now(),
    pending: true,
    read: false
  }]);
  const crossDeviceNotify = await context.notifyOnce(first, notifyRecord, 'notif-page-1', '333 Watcher');
  assert.equal(crossDeviceNotify.ok, true);
  assert.equal(crossDeviceNotify.skipped, true);
  assert.equal(notificationCount, 1, 'an active cross-device claim must suppress a duplicate');

  // 崩溃遗留的过期认领不应永久阻塞通知。
  // 必须用一个从未投递过的新事件：first 前面已经真的发出过一次，
  // 它的已投递标记还在（deliveredEvents），换事件才能真正测到
  // "过期且未投递的认领不阻塞"这一点，而不是被标记先一步拦掉。
  const expiredEvent = { eventKey: 'v1-expired-claim', url: eventBase.url, message: 'expired claim test' };
  syncStore.set('history', [{
    id: 'stale-claim',
    url: eventBase.url,
    message: expiredEvent.message,
    eventKey: expiredEvent.eventKey,
    claimAt: Date.now() - 10 * 60 * 1000,
    pending: true,
    read: false
  }]);
  const staleClaimNotify = await context.notifyOnce(
    expiredEvent,
    { ...notifyRecord, message: expiredEvent.message },
    'notif-page-1',
    '333 Watcher'
  );
  assert.equal(staleClaimNotify.ok, true);
  assert.notEqual(staleClaimNotify.skipped, true, 'an expired claim must not block the notification');
  assert.equal(notificationCount, 2);

  // 端到端仲裁：本机认领成功后，另一台设备的认领也落到 history 里，
  // 两条 pending 并存时只有确定性赢家发送，另一台必须撤回自己的认领。
  syncStore.clear();
  notificationCount = 0;
  const base = Date.now() - 5000;
  const winnerClaim = {
    id: 'winner-claim',
    url: eventBase.url,
    message: next.message,
    eventKey: next.eventKey,
    claimAt: base,
    pending: true,
    read: false
  };
  const originalSet = context.chrome.storage.sync.set;
  let firstWrite = true;
  context.chrome.storage.sync.set = async (values) => {
    if (firstWrite && Array.isArray(values.history)) {
      firstWrite = false;
      // 本机先写入自己的（较晚的）认领，随后另一台设备的认领也落盘。
      await originalSet(values);
      const mine = values.history[0];
      await originalSet({ history: [mine, winnerClaim] });
      return;
    }
    return originalSet(values);
  };
  const arbitrated = await context.notifyOnce(next, { ...notifyRecord, message: next.message }, 'notif-page-1', '333 Watcher');
  context.chrome.storage.sync.set = originalSet;
  assert.equal(arbitrated.ok, true);
  assert.equal(arbitrated.skipped, true, 'the losing claim must not send a notification');
  assert.equal(notificationCount, 0, 'the losing claim must not notify at all');
  assert.equal(
    syncStore.get('history').some((h) => h.id !== 'winner-claim' && h.eventKey === next.eventKey),
    false,
    'the losing claim must be released so it cannot block the winner'
  );

  // -------- 跨设备认领仲裁窗口（重复通知的真正根因） --------
  // storage.sync 是最终一致的：A 写下的认领要经过同步传播才可能被 B 读到。
  // 旧实现固定等 600ms 只读一次 history，传播稍慢时两台设备都只看到自己的认领，
  // 于是同一事件各发一条一模一样的通知（用户表现为"换台电脑又收到一遍"）。
  // 现在窗口内持续轮询：只要在窗口内看到对手就立刻按全序仲裁。
  const localDeviceId = 'd-self-test';
  localStore.set('_333_device_id', localDeviceId);
  const multiEvent = { eventKey: 'v1-arb-window', url: eventBase.url, message: 'window test' };
  const multiRecord = { name: 'page-1', url: eventBase.url, message: multiEvent.message, kind: 'change' };

  // arbitrateClaim 直接单测：认领被清掉 / 输给更早的对手 / 独占窗口。
  syncStore.clear();
  syncStore.set('devices', { [localDeviceId]: vNow, 'd-foreign': vNow });
  assert.equal(
    await context.arbitrateClaim(multiEvent, 'claim-vanished'),
    'skip',
    'a claim that disappeared from history must not notify'
  );
  syncStore.set('history', [
    { id: 'mine-late', eventKey: multiEvent.eventKey, claimAt: vNow, pending: true },
    { id: 'rival-early', eventKey: multiEvent.eventKey, claimAt: vNow - 1000, pending: true },
  ]);
  assert.equal(
    await context.arbitrateClaim(multiEvent, 'mine-late'),
    'skip',
    'a later claim must lose to the earliest rival'
  );
  assert.equal(
    await context.arbitrateClaim(multiEvent, 'rival-early'),
    'send',
    'the earliest claim must win immediately instead of waiting out the window'
  );

  // 端到端回归：多设备场景下，对手的认领在第 3 次读 history 时才同步过来。
  // 旧实现（固定 600ms 单次读）会看不到对手并各发一条通知；新实现必须撤回自己。
  syncStore.clear();
  syncStore.set('devices', { 'd-foreign': vNow });
  notificationCount = 0;
  const lateRival = {
    id: 'late-rival',
    url: multiEvent.url,
    message: multiEvent.message,
    eventKey: multiEvent.eventKey,
    claimAt: vNow - 5000,
    pending: true,
    read: false
  };
  const originalGet = context.chrome.storage.sync.get;
  let historyReads = 0;
  context.chrome.storage.sync.get = async (key) => {
    const data = await originalGet(key);
    if (key === 'history' && ++historyReads === 3) {
      // 模拟同步延迟：对手的认领在本机认领之后才传播过来。
      const current = await originalGet('history');
      await context.chrome.storage.sync.set({ history: [current[0], lateRival].filter(Boolean) });
    }
    return data;
  };
  const windowed = await context.notifyOnce(multiEvent, multiRecord, 'notif-window', '333 Watcher');
  context.chrome.storage.sync.get = originalGet;
  assert.equal(windowed.ok, true);
  assert.equal(windowed.skipped, true, 'a rival claim synced in mid-window must suppress the duplicate');
  assert.equal(notificationCount, 0, 'the late-arriving rival case must not notify at all');
  assert.equal(
    syncStore.get('history').some((h) => h.id !== 'late-rival' && h.eventKey === multiEvent.eventKey),
    false,
    'the losing claim must be released so the winner on the other device is not blocked'
  );

  // 回归：对手已经"发完"（pending:false, delivered:true）时，本机必须撤回。
  //
  // 真实时序：storage.sync 传播要几百毫秒，而对手赢下仲裁后立刻调用
  // completeNotificationClaim 把自己的认领置为 pending:false。等本机在窗口内
  // 读到这条记录时，对手早已投递完毕 —— 旧实现只把"仍 pending"的认领当成
  // 竞争者（isActiveClaim），已投递的记录被过滤掉，于是本机认为无人竞争，
  // 等满窗口后又发一条一模一样的提醒（用户表现为同一条提醒收到两遍）。
  //
  // 注意：认领成功与否只在 claimNotificationEvent 里查过一次 hasSeenEvent，
  // 仲裁阶段不再复查，所以"已投递"必须在这里单独判定。
  syncStore.clear();
  syncStore.set('devices', { [localDeviceId]: vNow, 'd-foreign': vNow });
  const settledRival = {
    id: 'settled-rival',
    eventKey: multiEvent.eventKey,
    claimAt: vNow - 1000,
    pending: false,
    delivered: true
  };
  syncStore.set('history', [
    { id: 'mine-settled-race', eventKey: multiEvent.eventKey, claimAt: vNow, pending: true },
    settledRival
  ]);
  assert.equal(
    await context.arbitrateClaim(multiEvent, 'mine-settled-race'),
    'skip',
    'an already-delivered rival must suppress the duplicate notification'
  );
  // 对手已投递（pending:false）不是"活跃竞争者"，不应参与赢家排序。
  assert.equal(
    context.rivalClaimsOf({ eventKey: multiEvent.eventKey }, syncStore.get('history'), 'mine-settled-race').length,
    0,
    'a settled record must not count as an active rival claim'
  );
  // 仍未投递的过期认领不能当成"已投递"，否则崩溃遗留的记录会永久吞掉提醒。
  syncStore.set('history', [
    { id: 'mine-expired-race', eventKey: multiEvent.eventKey, claimAt: vNow, pending: true },
    { id: 'expired-rival', eventKey: multiEvent.eventKey, claimAt: vNow - 10 * 60 * 1000, pending: true }
  ]);
  assert.equal(
    await context.arbitrateClaim(multiEvent, 'mine-expired-race'),
    'send',
    'an expired undelivered rival must not block the notification'
  );

  // 回归：赢家的"已投递"标记被输家的撤回写覆盖掉时，不得再发第二条。
  //
  // withHistoryLock 只是进程内互斥，跨设备依然是整键读-改-写、后写者覆盖。
  // 赢家投完通知调 completeNotificationClaim 写入 delivered:true，
  // 输家同时在 releaseNotificationClaim 里撤掉自己的认领 —— 两次写同一个
  // history 键，谁后落地不受控。输家的旧快照里赢家的记录还是 pending:true，
  // 于是 delivered:true 被覆盖回"认领中"。
  // 2 分钟后那条记录过期：既不算活跃竞争者（isActiveClaim 为假），
  // 也不算已投递（delivered 标志已被抹掉），于是同一次变化被当成
  // "从未提醒过"，再发一条一模一样的通知 —— 正是用户遇到的重复提醒。
  // 独立的 deliveredEvents 键只有赢家会写，输家的撤回碰不到它，
  // 因此标记不会被回滚。
  syncStore.clear();
  syncStore.set('devices', { [localDeviceId]: vNow, 'd-foreign': vNow });
  const clobberEvent = { eventKey: 'v1-clobbered', url: eventBase.url, message: 'clobber test' };
  syncStore.set('deliveredEvents', { 'v1-clobbered': vNow });
  syncStore.set('history', [{
    id: 'clobbered-claim',
    eventKey: 'v1-clobbered',
    claimAt: vNow - 10 * 60 * 1000,
    pending: true
  }]);
  notificationCount = 0;
  const clobbered = await context.notifyOnce(
    clobberEvent,
    { name: 'page-1', url: eventBase.url, message: clobberEvent.message, kind: 'change' },
    'notif-clobber',
    '333 Watcher'
  );
  assert.equal(
    clobbered.skipped,
    true,
    'a durable delivered marker must suppress the duplicate even after the history record was clobbered'
  );
  assert.equal(notificationCount, 0, 'a clobbered history record must never cause a second notification');

  // 正向路径：投递成功必须留下标记，投递失败必须不留下。
  // 失败时不写标记是关键 —— 否则一次偶发的通知失败会把这条提醒永久吞掉，
  // 用户再也收不到本该收到的下一次提醒。
  syncStore.clear();
  syncStore.set('devices', { [localDeviceId]: vNow });
  notificationCount = 0;
  const markedEvent = { eventKey: 'v1-marked', url: eventBase.url, message: 'marked test' };
  await context.notifyOnce(
    markedEvent,
    { name: 'page-1', url: eventBase.url, message: markedEvent.message, kind: 'change' },
    'notif-marked',
    '333 Watcher'
  );
  assert.equal(notificationCount, 1);
  assert.equal(
    await context.isEventDelivered('v1-marked'),
    true,
    'a successful send must record a durable delivered marker'
  );

  // 投递失败：认领被删除、且不能留下标记，下一轮检查必须还能重试。
  syncStore.clear();
  const realNotificationsCreate = chrome.notifications.create;
  chrome.notifications.create = (_id, _options, callback) => { callback('notif-err'); };
  // sendNotification 是靠 chrome.runtime.lastError 判定失败的，
  // 回调参数本身不算错误。
  chrome.runtime.lastError = { message: 'notification failed' };
  notificationCount = 0;
  const failedEvent = { eventKey: 'v1-failed', url: eventBase.url, message: 'failed test' };
  const failedResult = await context.notifyOnce(
    failedEvent,
    { name: 'page-1', url: eventBase.url, message: failedEvent.message, kind: 'change' },
    'notif-failed',
    '333 Watcher'
  );
  chrome.notifications.create = realNotificationsCreate;
  chrome.runtime.lastError = null;
  assert.equal(failedResult.ok, false, 'the failing send must report failure');
  assert.equal(
    await context.isEventDelivered('v1-failed'),
    false,
    'a failed send must not record a delivered marker, or the reminder would be lost forever'
  );

  // 单设备快速路径：没有其它设备时窗口必须保持 600ms，不能被无条件拉长。
  syncStore.clear();
  syncStore.set('devices', { [localDeviceId]: vNow });
  notificationCount = 0;
  const singleEvent = { eventKey: 'v1-arb-single', url: eventBase.url, message: 'single test' };
  const beforeSingle = vNow;
  const single = await context.notifyOnce(
    singleEvent,
    { name: 'page-1', url: eventBase.url, message: singleEvent.message, kind: 'change' },
    'notif-single',
    '333 Watcher'
  );
  const singleElapsed = vNow - beforeSingle;
  assert.equal(single.skipped, undefined, 'a sole device must still notify');
  assert.equal(notificationCount, 1);
  assert.ok(singleElapsed < 2000, 'the single-device window must stay short, got ' + singleElapsed + 'ms');
  assert.ok(singleElapsed >= 600, 'the single-device window must actually wait, got ' + singleElapsed + 'ms');

  // 多设备窗口确实被拉长：只有真的存在别的设备时才等满 5 秒。
  syncStore.clear();
  syncStore.set('devices', { [localDeviceId]: vNow, 'd-foreign': vNow });
  const slowEvent = { eventKey: 'v1-arb-slow', url: eventBase.url, message: 'slow test' };
  await context.notifyOnce(
    slowEvent,
    { name: 'page-1', url: eventBase.url, message: slowEvent.message, kind: 'change' },
    'notif-slow',
    '333 Watcher'
  );
  assert.ok(
    vNow - singleElapsed - beforeSingle >= 5000,
    'a multi-device profile must use the longer arbitration window'
  );

  // 并发认领不得丢记录：history 写入已串行化，最后写入的认领必须保留。
  syncStore.clear();
  const concurrent = await Promise.all([
    context.claimNotificationEvent({ eventKey: 'par-1' }, { name: 'a', url: 'https://example.test/a', message: 'm1' }),
    context.claimNotificationEvent({ eventKey: 'par-2' }, { name: 'b', url: 'https://example.test/b', message: 'm2' }),
    context.claimNotificationEvent({ eventKey: 'par-3' }, { name: 'c', url: 'https://example.test/c', message: 'm3' }),
  ]);
  assert.equal(concurrent.filter((c) => c.claimed).length, 3, 'all distinct events must be claimed');
  const keptPar = syncStore.get('history');
  assert.equal(keptPar.length, 3, 'serialized history writes must not lose concurrent claims');
  for (const key of ['par-1', 'par-2', 'par-3']) {
    assert.equal(
      keptPar.some((h) => h.eventKey === key),
      true,
      'claim ' + key + ' must survive concurrent writes'
    );
  }

  // popup 的“全部已读”必须走 background，且不得把未完成投递的认领标记为已读。
  syncStore.clear();
  const claimNow = Date.now();
  syncStore.set('history', [
    { id: 'r1', name: 'a', url: 'https://example.test/a', message: 'm1', eventKey: 'r-1', read: false },
    { id: 'r2', name: 'b', url: 'https://example.test/b', message: 'm2', eventKey: 'r-2', claimAt: claimNow, pending: true, read: false },
    { id: 'r3', name: 'c', url: 'https://example.test/c', message: 'm3', eventKey: 'r-3', read: true, readAt: claimNow },
    null,
  ]);
  const markAll = await sendMessage({ type: 'mark-all-history-read' });
  assert.equal(markAll.ok, true, 'mark-all-history-read must respond ok');
  assert.equal(markAll.updated, 1, 'only the unread non-pending record may be marked read');
  const afterMarkAll = syncStore.get('history');
  assert.equal(afterMarkAll.find((h) => h && h.id === 'r1').read, true, 'unread record must become read');
  assert.equal(afterMarkAll.find((h) => h && h.id === 'r2').read, false, 'a pending claim must stay unread');
  assert.equal(afterMarkAll.find((h) => h && h.id === 'r2').pending, true, 'a pending claim must not be mutated');
  assert.equal(
    afterMarkAll.some((h) => h === null),
    false,
    'null history entries must not crash the mark-read path and should be pruned'
  );

  const markOne = await sendMessage({ type: 'mark-history-read', id: 'r3' });
  assert.equal(markOne.ok, true);
  assert.equal(markOne.updated, 0, 'an already-read record must not be updated again');
  const markPending = await sendMessage({ type: 'mark-history-read', id: 'r2' });
  assert.equal(markPending.ok, true);
  assert.equal(
    syncStore.get('history').find((h) => h && h.id === 'r2').read,
    false,
    'marking a single pending claim must not mark it read'
  );

  // pruneHistory 应清除过期未完成的认领。
  syncStore.set('history', [{
    id: 'stale-claim-2',
    url: eventBase.url,
    message: first.message,
    eventKey: next.eventKey,
    claimAt: Date.now() - 10 * 60 * 1000,
    pending: true,
    read: false
  }]);
  await context.pruneHistory();
  assert.equal(syncStore.get('history').length, 0, 'expired pending claims should be pruned');

  // popup 打开时也会裁剪历史。这条路径必须走 background：popup 与后台是两个
  // JS 上下文，进程内互斥锁互不生效，popup 拿旧快照整键写回会把后台刚写入的
  // **在途认领**一起抹掉 —— arbitrateClaim 发现认领不见了就判 'skip'，
  // 提醒被静默吞掉（用户看到"页面明明变了却没提醒"）。
  syncStore.clear();
  syncStore.set('history', [
    // 刚过期、应当被裁掉的记录：确保裁剪逻辑确实动了数据（不是空转早退）。
    { id: 'stale-claim-3', url: eventBase.url, message: 'old', eventKey: 'ev-stale', claimAt: Date.now() - 10 * 60 * 1000, pending: true, read: false },
    // 后台刚写入的在途认领：TTL 内，必须原样保留。
    { id: 'inflight-claim', url: eventBase.url, message: 'new', eventKey: 'ev-inflight', claimAt: Date.now(), pending: true, read: false },
  ]);
  const pruned = plain(await sendMessage({ type: 'prune-history' }));
  assert.equal(pruned.ok, true, 'prune-history must respond ok');
  const afterPrune = syncStore.get('history');
  assert.equal(
    afterPrune.filter((h) => h && h.id === 'stale-claim-3').length,
    0,
    'an expired pending claim must still be pruned by the popup path'
  );
  assert.equal(
    afterPrune.filter((h) => h && h.id === 'inflight-claim').length,
    1,
    'pruning must never drop an in-flight claim written by the background'
  );

  // 端到端：另一台设备已记录基线时，本机不再重复通知，且保留存储中的基线。
  syncStore.clear();
  notificationCount = 0;
  const e2eHtml = '<html><body>C</body></html>';
  const htmlRes = { ok: true, headers: { get: () => String(e2eHtml.length) } };
  context.__setFetch(async () => ({
    ok: true,
    status: 200,
    headers: htmlRes.headers,
    body: null,
    text: async () => e2eHtml,
  }));
  const pageMonitor = {
    id: 'page-e2e',
    name: 'e2e',
    url: 'https://example.test/e2e',
    type: 'page',
    interval: 5,
    lastHash: 'stale-hash-from-this-device',
    baselined: true,
    eventSeq: 3,
  };
  // 存储中的基线已被另一台设备推进，且与本机快照不同 -> 视为已被抢先记录
  syncStore.set('monitors', [{
    ...pageMonitor,
    lastHash: 'hash-written-by-other-device',
    lastValue: '',
  }]);
  const supersededResult = await context.checkMonitor(pageMonitor);
  assert.equal(supersededResult, 'changed-elsewhere', 'a superseded change must not notify');
  assert.equal(notificationCount, 0, 'no notification may be sent for a superseded change');
  assert.equal(
    syncStore.get('monitors')[0].lastHash,
    'hash-written-by-other-device',
    'the stored baseline must survive a superseded check'
  );
  assert.equal(
    syncStore.get('monitors')[0].eventSeq,
    3,
    'a superseded change must not consume an event sequence'
  );

  // 端到端：基线一致时正常通知，并消耗一个事件序号。
  syncStore.clear();
  notificationCount = 0;
  const freshHtml = '<html><body>D</body></html>';
  const freshNextHtml = '<html><body>E</body></html>';
  context.__setFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(freshHtml.length) },
    body: null,
    text: async () => freshHtml,
  }));
  const freshMonitor = {
    id: 'page-fresh',
    name: 'fresh',
    url: 'https://example.test/fresh',
    type: 'page',
    interval: 5,
    lastHash: null,
    baselined: true,
    eventSeq: 7,
  };
  const freshOutcome = await context.checkPage(freshMonitor, freshHtml);
  freshMonitor.lastHash = freshOutcome.update.lastHash;
  syncStore.set('monitors', [{ ...freshMonitor }]);
  context.__setFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(freshNextHtml.length) },
    body: null,
    text: async () => freshNextHtml,
  }));
  const freshResult = await context.checkMonitor(freshMonitor);
  assert.equal(freshResult, 'changed', 'a real change must still notify');
  assert.equal(notificationCount, 1, 'a real change must send exactly one notification');
  assert.equal(syncStore.get('monitors')[0].eventSeq, 8, 'a real change must consume an event sequence');

  // 同步存储写失败时：返回 error，并且绝不能发通知（基线没落盘，通知无法追溯）。
  syncStore.clear();
  notificationCount = 0;
  const quotaHtml = '<html><body>F</body></html>';
  context.__setFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(quotaHtml.length) },
    body: null,
    text: async () => quotaHtml,
  }));
  const quotaMonitor = {
    id: 'page-quota',
    name: 'quota',
    url: 'https://example.test/quota',
    type: 'page',
    interval: 5,
    lastHash: null,
    baselined: true,
    eventSeq: 2,
  };
  const quotaBase = await context.checkPage(quotaMonitor, quotaHtml);
  quotaMonitor.lastHash = quotaBase.update.lastHash;
  syncStore.set('monitors', [{ ...quotaMonitor }]);
  context.__setFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String((quotaHtml + '!').length) },
    body: null,
    text: async () => quotaHtml + '!',
  }));
  const realSet = chrome.storage.sync.set;
  chrome.storage.sync.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  let quotaResult;
  try {
    quotaResult = await context.checkMonitor(quotaMonitor);
  } finally {
    chrome.storage.sync.set = realSet;
  }
  assert.equal(quotaResult, 'error', 'a failed baseline write must report an error');
  assert.equal(notificationCount, 0, 'a failed baseline write must not notify');
  assert.equal(
    syncStore.get('monitors')[0].eventSeq,
    2,
    'a failed baseline write must not consume an event sequence'
  );
  assert.equal(
    await context.checkMonitor(quotaMonitor),
    'changed',
    'a failed check must release its in-flight lock so the next round retries'
  );
  assert.equal(notificationCount, 1, 'the retried round notifies exactly once after storage recovers');

  // ---- 抖动（二次确认不一致）回写基线时，不得把别的设备已推进的基线倒回去 ----
  // 场景：本机第一次抓到 a.zip -> changed 并已把基线写成 a.zip；二次确认抓到
  // b.zip -> 判定抖动、不发通知。此时另一台设备已把基线推进到更新的 c.zip，
  // 抖动回写若无条件写 b.zip，就会把基线倒推，让同一次变化被反复判定、重复通知。
  syncStore.clear();
  notificationCount = 0;
  const linkHtml = (href) => `<html><body><a href="${href}">Download</a></body></html>`;
  const flakyMonitor = {
    id: 'dl-flaky',
    name: 'flaky',
    url: 'https://example.test/download',
    type: 'download',
    interval: 5,
    targetText: 'Download',
    lastValue: 'https://example.test/old.zip',
    baselined: true,
    eventSeq: 4,
  };
  syncStore.set('monitors', [{ ...flakyMonitor }]);
  const fetched = [];
  context.__setFetch(async () => {
    const href = fetched.length === 0 ? 'https://example.test/a.zip' : 'https://example.test/b.zip';
    fetched.push(href);
    const html = linkHtml(href);
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(html.length) },
      body: null,
      text: async () => html,
    };
  });
  // 模拟"二次确认期间别的设备把基线推进到 c.zip"：在抖动回写读到列表时注入。
  const realSyncGetForFlaky = chrome.storage.sync.get;
  let injectedFlaky = false;
  chrome.storage.sync.get = async (key) => {
    const data = await realSyncGetForFlaky(key);
    const list = data && data.monitors;
    if (!injectedFlaky && key === 'monitors' && Array.isArray(list)
        && list[0] && list[0].lastValue === 'https://example.test/a.zip') {
      injectedFlaky = true;
      syncStore.set('monitors', list.map((m) => (
        m.id === flakyMonitor.id ? { ...m, lastValue: 'https://example.test/c.zip' } : m
      )));
      return { monitors: syncStore.get('monitors') };
    }
    return data;
  };
  let flakyResult;
  try {
    flakyResult = await context.checkMonitor(flakyMonitor);
  } finally {
    chrome.storage.sync.get = realSyncGetForFlaky;
  }
  assert.equal(injectedFlaky, true, 'the flaky write-back must have reached the storage read');
  assert.equal(flakyResult, 'flaky', 'an unstable second fetch must be reported as flaky');
  assert.equal(notificationCount, 0, 'a flaky change must not notify');
  assert.equal(
    syncStore.get('monitors')[0].lastValue,
    'https://example.test/c.zip',
    'a flaky write-back must not roll the baseline back over a newer value'
  );

  // ---- 启动补检：单个监控抛错不得中断其余监控的补检 ----
  // 通知链路里任何一次 history 写入失败（配额/离线）都会让 notifyOnce reject，
  // 而 checkMonitor 没有兜底 catch，异常会一路冒泡出 catchUpChecks 的 for 循环，
  // 导致后面所有逾期监控在本次开机补检中被静默跳过。
  syncStore.clear();
  notificationCount = 0;
  const pageHtml = '<html><body>catchup</body></html>';
  const catchupBase = await context.checkPage({ id: 'cu-page', type: 'page' }, pageHtml);
  const catchupPage = {
    id: 'cu-page',
    name: 'cu-page',
    url: 'https://example.test/catchup-page',
    type: 'page',
    interval: 5,
    lastHash: catchupBase.update.lastHash,
    baselined: true,
    nextCheckTime: 0,
    eventSeq: 0,
  };
  const catchupLink = {
    id: 'cu-link',
    name: 'cu-link',
    url: 'https://example.test/catchup-link',
    type: 'download',
    interval: 5,
    targetText: 'Download',
    lastValue: 'https://example.test/old.zip',
    baselined: true,
    nextCheckTime: 0,
    eventSeq: 0,
  };
  syncStore.set('monitors', [catchupLink, catchupPage]);
  context.__setFetch(async (url) => {
    const html = String(url).includes('catchup-link')
      ? linkHtml('https://example.test/new.zip')
      : pageHtml;
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(html.length) },
      body: null,
      text: async () => html,
    };
  });
  // history 写不进去（模拟配额不足）：通知必然失败。
  const realSyncSetForCatchup = chrome.storage.sync.set;
  chrome.storage.sync.set = async (values) => {
    if (Object.prototype.hasOwnProperty.call(values, 'history')) {
      throw new Error('QUOTA_BYTES quota exceeded');
    }
    return realSyncSetForCatchup(values);
  };
  try {
    await context.catchUpChecks();
  } finally {
    chrome.storage.sync.set = realSyncSetForCatchup;
  }
  const afterCatchup = syncStore.get('monitors');
  assert.ok(
    afterCatchup.find((m) => m.id === 'cu-link').lastCheck,
    'the failing monitor must still record its check'
  );
  assert.ok(
    afterCatchup.find((m) => m.id === 'cu-page').lastCheck,
    'a failing monitor must not abort catch-up for the remaining monitors'
  );
  assert.equal(notificationCount, 0, 'a failed history write must not notify');

  // ---- 启动补检：监控自身抛错（非通知链路）同样不得中断补检循环 ----
  // checkMonitor 开头的 getMonitors() 不在 try 内，storage 抛错会直接冒泡出
  // catchUpChecks 的 for 循环，第二个逾期监控就再也不会被检查。
  syncStore.clear();
  notificationCount = 0;
  const guardHtml = '<html><body>guard</body></html>';
  const guardBase = await context.checkPage({ id: 'g-page', type: 'page' }, guardHtml);
  const guardPageA = {
    id: 'g-page-a', name: 'g-a', url: 'https://example.test/g-a', type: 'page',
    interval: 5, lastHash: guardBase.update.lastHash, baselined: true, nextCheckTime: 0, eventSeq: 0,
  };
  const guardPageB = {
    id: 'g-page-b', name: 'g-b', url: 'https://example.test/g-b', type: 'page',
    interval: 5, lastHash: guardBase.update.lastHash, baselined: true, nextCheckTime: 0, eventSeq: 0,
  };
  syncStore.set('monitors', [guardPageA, guardPageB]);
  context.__setFetch(async () => ({
    ok: true, status: 200, headers: { get: () => String(guardHtml.length) },
    body: null, text: async () => guardHtml,
  }));
  // 只让第一个监控的检查抛错（模拟 storage 读取异常），第二个必须照常补检。
  const realCheckMonitor = context.checkMonitor;
  context.checkMonitor = async (m) => {
    if (m.id === 'g-page-a') throw new Error('storage exploded');
    return realCheckMonitor(m);
  };
  try {
    await context.catchUpChecks();
  } finally {
    context.checkMonitor = realCheckMonitor;
  }
  assert.ok(
    syncStore.get('monitors').find((m) => m.id === 'g-page-b').lastCheck,
    'a throwing monitor must not abort catch-up for the remaining monitors'
  );

  // ---- monitors 整键读-改-写必须串行化，否则并发写入互相覆盖 ----
  syncStore.clear();
  // 给 storage 读加延迟：没有互斥锁时两个读会交错，导致后写者覆盖先写者。
  const realSyncGet = chrome.storage.sync.get;
  chrome.storage.sync.get = async (key) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return realSyncGet(key);
  };
  try {
    await Promise.all([
      context.mutateMonitors((list) => { list.push({ id: 'p1', url: 'https://example.test/1', type: 'page' }); return true; }),
      context.mutateMonitors((list) => { list.push({ id: 'p2', url: 'https://example.test/2', type: 'page' }); return true; }),
      context.mutateMonitors((list) => { list.push({ id: 'p3', url: 'https://example.test/3', type: 'page' }); return true; }),
    ]);
  } finally {
    chrome.storage.sync.get = realSyncGet;
  }
  assert.deepEqual(
    syncStore.get('monitors').map((m) => m.id),
    ['p1', 'p2', 'p3'],
    'concurrent monitor writes must not lose records'
  );

  // 弃写：mutator 返回 false 时不得落盘。
  await context.mutateMonitors(() => false);
  assert.equal(syncStore.get('monitors').length, 3, 'an aborted mutation must not be written');

  // ---- popup 的 mutate-monitors 通道：必须基于存储里的最新列表，而不是页面旧快照 ----
  const ids = () => syncStore.get('monitors').map((m) => m.id);
  assert.deepEqual(plain(await sendMessage({
    type: 'mutate-monitors',
    op: 'upsert',
    monitor: { id: 'p1', url: 'https://example.test/1', type: 'page', name: 'renamed' },
  })), {
    ok: true, id: 'p1', mode: 'updated',
  });
  assert.equal(syncStore.get('monitors')[0].name, 'renamed', 'upsert must replace the existing monitor');
  assert.deepEqual(ids(), ['p1', 'p2', 'p3'], 'upsert must not disturb other monitors');

  assert.deepEqual(plain(await sendMessage({
    type: 'mutate-monitors',
    op: 'upsert',
    monitor: { id: 'p4', url: 'https://example.test/4', type: 'page' },
  })), {
    ok: true, id: 'p4', mode: 'added',
  });
  assert.deepEqual(ids(), ['p1', 'p2', 'p3', 'p4'], 'a new monitor id must be appended');

  assert.deepEqual(plain(await sendMessage({ type: 'mutate-monitors', op: 'remove', id: 'p2' })), { ok: true, removed: 1 });
  assert.deepEqual(ids(), ['p1', 'p3', 'p4'], 'remove must delete only the requested monitor');
  assert.deepEqual(plain(await sendMessage({ type: 'mutate-monitors', op: 'remove', id: 'nope' })), { ok: true, removed: 0 });
  assert.deepEqual(ids(), ['p1', 'p3', 'p4'], 'removing an unknown id must be a no-op');

  await sendMessage({ type: 'mutate-monitors', op: 'set-interval', interval: 500 });
  assert.deepEqual(
    syncStore.get('monitors').map((m) => m.interval),
    [500, 500, 500],
    'set-interval must update every monitor'
  );

  const imported = await sendMessage({
    type: 'mutate-monitors',
    op: 'import-by-key',
    monitors: [
      { id: 'imp-1', url: 'https://example.test/imported', type: 'page' },
      { id: 'imp-2', url: 'https://example.test/p1-url', type: 'page' },
    ],
  });
  assert.equal(imported.added, 2, 'import must count newly added monitors');
  assert.equal(imported.total, 5, 'import must merge into the existing list');
  assert.equal(ids().includes('imp-1'), true, 'import must keep the imported monitor');
  assert.equal(ids().includes('p1'), true, 'import must not drop existing monitors');

  // ---------------- 导入：id 撞车 ----------------
  // id 同时是 alarm 名（ALARM_PREFIX+id）、通知 id（notif-<id>）和
  // 检查锁（_checkLock）的键。旧实现用导入项整体替换同 key 的旧项，
  // 于是备份文件里的 id 会顶掉本机已存在的 id：
  //   1) 同一份备份在两台机器上导入时，id 极可能和本机独立创建的监控撞车；
  //   2) 撞车后两条监控共用一个 alarm —— syncAlarms 的 wanted 集合里只有
  //      一个名字，其中一条**再也不会被检查**；
  //   3) findIndex(m.id === ...) 永远只命中第一条，基线会写到错的监控上。
  // 导入必须保留本机已存在的 id（身份属于本机），并对真正的撞车重新发号。
  const beforeById = new Map(syncStore.get('monitors').map((m) => [m.id, m.url]));
  const beforeIds = [...beforeById.keys()];
  const collided = await sendMessage({
    type: 'mutate-monitors',
    op: 'import-by-key',
    monitors: [
      // 同 key（同一 url/selector），但备份里的 id 与本机不同。
      { id: 'from-backup-A', url: beforeById.get(beforeIds[0]), type: 'page' },
      // 全新 key，但 id 恰好等于本机另一条监控的 id。
      { id: beforeIds[0], url: 'https://example.test/brand-new', type: 'page' },
    ],
  });
  assert.equal(collided.added, 1, 'only the genuinely new monitor counts as added');
  const afterIds = ids();
  assert.equal(
    new Set(afterIds).size,
    afterIds.length,
    'every monitor id must stay unique after an import, got: ' + afterIds.join(', ')
  );
  assert.equal(
    afterIds.includes('from-backup-A'),
    false,
    'merging into an existing monitor must keep the local id, not adopt the backup id'
  );
  assert.equal(
    afterIds.includes(beforeIds[0]),
    true,
    'the pre-existing monitor must keep its id'
  );
  // 每个 id 都要能解析回唯一一条监控（alarm 就是靠这个 id 找到目标的）。
  const byId = new Map();
  for (const m of syncStore.get('monitors')) {
    assert.equal(byId.has(m.id), false, 'id ' + m.id + ' resolves to more than one monitor');
    byId.set(m.id, m);
  }
  // 原本持有该 id 的那条监控必须还是它自己：撞车时只应给**新来的**那条改号。
  assert.equal(
    byId.get(beforeIds[0]).url,
    beforeById.get(beforeIds[0]),
    'the id owner must not be silently reassigned to a different url'
  );

  // 页面侧新增去重读的是旧快照：并发下可能撞上同 key，background 必须兜底不建重复项。
  const countBeforeUpsert = syncStore.get('monitors').length;
  const dupeBackstop = plain(await sendMessage({
    type: 'mutate-monitors',
    op: 'upsert',
    monitor: { id: 'p9-fresh-id', url: 'https://example.test/1', type: 'page', name: 'raced' },
  }));
  assert.equal(dupeBackstop.mode, 'updated', 'an upsert colliding on monitorKey must update, not duplicate');
  assert.equal(dupeBackstop.id, 'p1', 'the colliding upsert must keep the existing monitor id');
  assert.equal(
    syncStore.get('monitors').length,
    countBeforeUpsert,
    'a colliding upsert must not add a row'
  );
  assert.equal(
    syncStore.get('monitors').find((m) => m.id === 'p1').name,
    'raced',
    'a colliding upsert must apply the new definition'
  );

  // id 撞车但 monitorKey 不同：绝不能当成"更新"把那条毫不相关的监控整条覆盖掉。
  // 页面侧 addMonitor 自己拼 id，撞上了就只能重新发号 + 按新增处理。
  const countBeforeIdClash = syncStore.get('monitors').length;
  // 动态挑一条当前真实存在的监控来撞 id：前面那几轮导入/去重已经改过 id 列表，
  // 写死 'p2' 会因为那条早已不存在而测不到真正的撞车分支。
  const clashVictim = syncStore.get('monitors')[0];
  const victimId = clashVictim.id;
  const victimUrl = clashVictim.url;
  const clash = plain(await sendMessage({
    type: 'mutate-monitors',
    op: 'upsert',
    monitor: { id: victimId, url: 'https://example.test/totally-different', type: 'page', name: 'clashing' },
  }));
  assert.equal(clash.mode, 'added', 'an id clash on a different monitor must be added under a fresh id');
  assert.notEqual(clash.id, victimId, 'the clashing monitor must be given a fresh id');
  assert.equal(
    syncStore.get('monitors').length,
    countBeforeIdClash + 1,
    'an id clash must add the new monitor, not replace the existing one'
  );
  assert.equal(
    syncStore.get('monitors').find((m) => m.id === victimId).url,
    victimUrl,
    'the monitor that owned the id must survive the id clash with its url intact'
  );
  // 同样的 key 再次提交时，仍要正常走更新分支（不能被上一条改动带偏）。
  const clashUpdate = plain(await sendMessage({
    type: 'mutate-monitors',
    op: 'upsert',
    monitor: {
      id: clash.id,
      url: 'https://example.test/totally-different',
      type: 'page',
      name: 'clashing renamed',
    },
  }));
  assert.equal(clashUpdate.mode, 'updated', 're-submitting the reassigned monitor must update it in place');
  assert.equal(clashUpdate.id, clash.id, 'the reassigned id must be stable across updates');
  assert.equal(
    syncStore.get('monitors').find((m) => m.id === clash.id).name,
    'clashing renamed',
    'the reassigned monitor must accept updates'
  );
  // 回到本节起点状态，后续断言继续用 p1/p2/p3。
  await sendMessage({
    type: 'mutate-monitors',
    op: 'remove',
    id: clash.id,
  });
  assert.equal(
    syncStore.get('monitors').length,
    countBeforeIdClash,
    'cleanup must restore the row count'
  );

  const bad = await sendMessage({ type: 'mutate-monitors', op: 'nope' });
  assert.equal(bad.ok, false, 'an unknown op must be rejected');
  assert.equal(
    syncStore.get('monitors').length,
    countBeforeUpsert,
    'an unknown op must not write'
  );

  syncStore.clear();
  syncStore.set('monitors', [{
    id: 'old-1',
    name: 'legacy',
    url: 'https://example.test/',
    type: 'element',
    selector: '#item',
    attribute: 'text',
    lastValue: 'old',
    failCount: 4,
    lastError: 'timeout',
    invalid: true,
    invalidReason: 'missing',
    invalidSince: '2026-09-24T00:00:00.000Z',
  }]);
  await context.migrateData();
  const migrated = syncStore.get('monitors')[0];
  assert.equal(migrated.failCount, 4);
  assert.equal(migrated.lastError, 'timeout');
  assert.equal(migrated.invalid, true);
  assert.equal(migrated.invalidReason, 'missing');
  assert.equal(migrated.invalidSince, '2026-09-24T00:00:00.000Z');

  // 回归：迁移时写 monitors 失败（配额不足）绝不能顺手删掉 watchers 旧数据。
  syncStore.clear();
  syncStore.set('watchers', [{ id: 'w-1', name: 'legacy page', url: 'https://legacy.test/' }]);
  const realSyncSet = chrome.storage.sync.set;
  chrome.storage.sync.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  await assert.rejects(
    () => context.migrateData(),
    // 用校验函数而不是正则：错误对象来自 vm realm，跨 realm 的 instanceof 会失配。
    (err) => err && err.code === 'SYNC_QUOTA',
    'a failed migration write must surface the quota error'
  );
  chrome.storage.sync.set = realSyncSet;
  assert.ok(
    syncStore.has('watchers'),
    'legacy watchers must survive a failed migration write (no data loss)'
  );
  assert.equal(syncStore.has('monitors'), false, 'a failed migration must not write monitors');

  // 迁移写成功后才允许清理旧键。
  await context.migrateData();
  assert.equal(syncStore.has('watchers'), false, 'a successful migration clears the legacy key');
  assert.equal(syncStore.get('monitors').length, 1, 'legacy watchers become monitors');
  assert.equal(syncStore.get('monitors')[0].url, 'https://legacy.test');

  // 迁移去重不能吞掉旧版链接监控：这些记录没有 selector，区分目标靠
  // targetHref/targetText。旧 monitorKey 只用 url+selector+attribute，
  // 于是同一页面上的 win.zip / mac.zip 两条监控 key 相同，每次启动迁移
  // 都会被合并成一条 —— 这是无声的数据丢失，不是显示问题。
  syncStore.clear();
  syncStore.set('monitors', [
    { id: 'old-win', url: 'https://legacy.test/dl', type: 'element', attribute: 'href', targetHref: 'https://legacy.test/win.zip', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'old-mac', url: 'https://legacy.test/dl', type: 'element', attribute: 'href', targetHref: 'https://legacy.test/mac.zip', createdAt: '2026-09-02T00:00:00.000Z' },
    { id: 'old-text-a', url: 'https://legacy.test/dl', type: 'element', attribute: 'text', targetText: 'Windows', createdAt: '2026-09-03T00:00:00.000Z' },
    { id: 'old-text-b', url: 'https://legacy.test/dl', type: 'element', attribute: 'text', targetText: 'macOS', createdAt: '2026-09-04T00:00:00.000Z' },
    { id: 'old-dup', url: 'https://legacy.test/dl', type: 'element', attribute: 'href', targetHref: 'https://legacy.test/win.zip', createdAt: '2026-09-05T00:00:00.000Z' },
  ]);
  await context.migrateData();
  const afterMigrate = syncStore.get('monitors');
  assert.equal(
    afterMigrate.length, 4,
    'migration must keep both legacy link targets and only collapse the true duplicate'
  );
  // migrateData 在 vm realm 里跑，写回的数组原型不是宿主的 Array，
  // deepEqual 会因原型不同误报，这里换回宿主数组再比。
  const keptTargets = Array.from(afterMigrate, (m) => m.targetHref + '|' + m.targetText).sort();
  assert.deepEqual(
    keptTargets,
    ['https://legacy.test/mac.zip|', 'https://legacy.test/win.zip|', '|Windows', '|macOS'],
    'migration must keep each distinct legacy link monitor'
  );

  // 迁移必须顺手修好重复/空 id：导入去重只覆盖"导入那一刻"，而重复 id 早就
  // 被旧版本写进存储了。修不好，syncAlarms 就给它们建同一个 alarm，
  // 其中一条再也不会被检查（用户表现为"某条监控突然不响了"）。
  syncStore.clear();
  syncStore.set('monitors', [
    { id: 'dup-a', url: 'https://legacy.test/one', type: 'page', updatedAt: 1 },
    // 与上一条同 id：早期按 URL 去重把两条不同监控并成一条时留下的坏状态。
    { id: 'dup-a', url: 'https://legacy.test/two', type: 'page', updatedAt: 2 },
    { id: '', url: 'https://legacy.test/three', type: 'page', updatedAt: 3 },
    { id: 'dup-a', url: 'https://legacy.test/four', type: 'page', updatedAt: 4 },
  ]);
  await context.migrateData();
  const healed = syncStore.get('monitors');
  assert.equal(healed.length, 4, 'migration must keep all four distinct monitors');
  const healedIds = Array.from(healed, (m) => m.id);
  assert.equal(
    new Set(healedIds).size,
    healedIds.length,
    'migration must leave every monitor id unique, got: ' + healedIds.join(', ')
  );
  assert.equal(
    healedIds.includes(''),
    false,
    'migration must replace an empty monitor id'
  );
  assert.equal(
    healedIds.filter((id) => id === 'dup-a').length,
    1,
    'exactly one monitor may keep the duplicated id'
  );
  // 每个 id 都要能解析回唯一一条监控 —— syncAlarms 正是靠这个 id 找目标。
  const healedById = new Map();
  for (const m of healed) {
    assert.equal(healedById.has(m.id), false, 'id ' + m.id + ' resolves to more than one monitor after migration');
    healedById.set(m.id, m);
  }
  assert.deepEqual(
    Array.from(healed, (m) => m.url).sort(),
    ['https://legacy.test/four', 'https://legacy.test/one', 'https://legacy.test/three', 'https://legacy.test/two'],
    'reassigning ids must not drop or rename any monitor'
  );

  // ---------------- 监控失效提醒的跨设备去重 ----------------
  // 用户反馈"在 A 电脑已经提醒过的内容，换到 B 电脑又收到一次"。
  // 变化类通知的 eventKey 只含基线值，两台设备算得一致；但"监控失效"不一样：
  // 它的 reason 来自 fetch 抛出的 err.message，强烈依赖本机网络环境 ——
  // 断网是 'Failed to fetch'、DNS 故障是 'net::ERR_NAME_NOT_RESOLVED'、
  // 反代拦截会变成 'HTTP 502'、超时被翻成 '请求超时'。
  // markCheckFailure 还会把 '（连续失败 N 次）' 拼进 reason，而两台设备的
  // 失败计数未必同步到同一步。同一场故障因此算出多个不同 eventKey：
  // deliveredEvents 查不到对方的标记，仲裁也认不出对手，各发一条。
  //
  // 先走真实链路：两台设备各自从"已失败 1 次、尚未失效"的同一基线出发，
  // 只是本机网络环境不同，于是 fetch 抛出的错误原文不同。
  syncStore.clear();
  localStore.clear();
  notificationCount = 0;
  const invMonitor = {
    id: 'inv-e2e',
    name: '公告页',
    url: 'https://inv.test/page',
    type: 'page',
    interval: 5,
    lastHash: 'h1',
    baselined: true,
    eventSeq: 7,
    failCount: 1,
    invalid: false,
  };
  // 设备 A：断网
  syncStore.set('monitors', [plain(invMonitor)]);
  context.__setFetch(async () => { throw new TypeError('Failed to fetch'); });
  await context.checkMonitor(plain(invMonitor));
  assert.equal(notificationCount, 1, 'device A must send the invalid notification');
  const deliveredAfterA = Object.keys(syncStore.get('deliveredEvents') || {});
  assert.equal(deliveredAfterA.length, 1, 'device A must leave a delivered marker for other devices');

  // 设备 B：同一时刻也判定失败，但它读到的是自己的旧基线（storage.sync 尚未
  // 把它那次 invalid 写回传播过来），而 DNS 故障的错误原文与 A 不同。
  syncStore.set('monitors', [plain(invMonitor)]);
  context.__setFetch(async () => { throw new TypeError('net::ERR_NAME_NOT_RESOLVED'); });
  await context.checkMonitor(plain(invMonitor));
  assert.equal(
    notificationCount,
    1,
    'a second device must not repeat the invalid notification for the same outage'
  );
  assert.equal(
    syncStore.get('monitors')[0].invalid,
    true,
    'the stored monitor must still be marked invalid'
  );

  // 反过来校验：真正的再次失效（用户修好后又坏）必须还能再次提醒。
  // 事件序号不同 -> 不该被上一轮的已投递标记误吞。
  syncStore.clear();
  localStore.clear();
  notificationCount = 0;
  const revived = { ...invMonitor, eventSeq: 12, failCount: 1, invalid: false };
  syncStore.set('monitors', [plain(revived)]);
  context.__setFetch(async () => { throw new TypeError('Failed to fetch'); });
  await context.checkMonitor(plain(revived));
  assert.equal(
    notificationCount,
    1,
    'a genuine later outage must still notify despite an older delivered marker'
  );

  // 以下为纯函数级断言，锁住"失效身份 = 监控 + 迁移序号"这条规则本身。
  const inv = { id: 'inv-1', name: '公告页', url: 'https://ex.test/p', type: 'page', eventSeq: 7 };
  const invalidKey = (reason) => {
    const message = '"公告页" 监控失效：' + reason + '\n请检查网址是否有效，或重新拾取元素';
    return context.buildNotificationEvent(inv, 'invalid', message, {
      sequence: inv.eventSeq,
      stableMessage: '"公告页" 监控失效'
    }).eventKey;
  };
  assert.equal(
    invalidKey('Failed to fetch（连续失败 2 次）'),
    invalidKey('net::ERR_NAME_NOT_RESOLVED（连续失败 2 次）'),
    'same outage must dedup across devices even when fetch error text differs'
  );
  assert.equal(
    invalidKey('HTTP 503（连续失败 3 次）'),
    invalidKey('HTTP 503（连续失败 2 次）'),
    'the fail-count suffix must not split one outage into per-device events'
  );
  assert.equal(
    invalidKey('请求超时（连续失败 2 次）'),
    invalidKey('Failed to fetch（连续失败 2 次）'),
    'timeout and offline are both "site unreachable" to the user'
  );
  // 真正的再次失效仍必须能再次提醒：状态迁移序号变了就是新事件。
  assert.notEqual(
    invalidKey('Failed to fetch（连续失败 2 次）'),
    context.buildNotificationEvent(
      { ...inv, eventSeq: 12 },
      'invalid',
      '"公告页" 监控失效：Failed to fetch\n请检查网址是否有效，或重新拾取元素',
      { sequence: 12, stableMessage: '"公告页" 监控失效' }
    ).eventKey,
    'a later invalid transition must remain a distinct event'
  );
  // 不同监控即便序号相同也必须各自提醒：monitorKey 与 name 都要参与去重。
  assert.notEqual(
    invalidKey('Failed to fetch（连续失败 2 次）'),
    context.buildNotificationEvent(
      { ...inv, url: 'https://ex.test/other', id: 'inv-2' },
      'invalid',
      '"公告页" 监控失效：Failed to fetch\n请检查网址是否有效，或重新拾取元素',
      { sequence: inv.eventSeq, stableMessage: '"公告页" 监控失效' }
    ).eventKey,
    'two different monitors must not share one invalid event'
  );
  // 变化类通知没有 stableMessage，正文本身即稳定输入，行为不应被改变。
  assert.equal(
    context.buildNotificationEvent(inv, 'change', '"公告页" 页面发生变化', { sequence: 7 }).eventKey,
    context.buildNotificationEvent(inv, 'change', '"公告页" 页面发生变化', { sequence: 7 }).eventKey,
    'change events stay deterministic without stableMessage'
  );

  // ---------------- offscreen 文档必须在查询失败时也关闭 ----------------
  // offscreen 文档是常驻 DOM 的后台文档，scheduleOffscreenClose 靠的是
  // background.js 里一个模块级 setTimeout。service worker 随时可能被终止，
  // 那个定时器随之消失 —— 所以关闭绝不能依赖"下一次成功查询顺带回收"。
  // 旧实现把 scheduleOffscreenClose() 放在 sendMessage 之后：一旦
  // sendMessage 抛错（SW 在消息在途时被终止、offscreen 文档先被关掉），
  // 关闭就被整个跳过，文档常驻到浏览器会话结束。
  const realSendMessage = chrome.runtime.sendMessage;
  offscreenOpen = false;
  chrome.runtime.sendMessage = async () => { throw new Error('Receiving end does not exist'); };
  await assert.rejects(
    () => context.queryElementValue('<p>x</p>', 'p', 'text'),
    /Receiving end does not exist/,
    'queryElementValue must propagate a failed offscreen query'
  );
  assert.equal(offscreenOpen, true, 'a failed query must still leave the document to be closed by the timer');
  // 把 3 秒关闭定时器跑掉：文档必须真的被关掉，而不是永远挂着。
  while (offscreenOpen) {
    const before = vTimers.size;
    assert.ok(pumpOneTimer(), 'a close timer must be pending after a failed query');
    if (vTimers.size === before) break;
  }
  assert.equal(
    offscreenOpen,
    false,
    'the offscreen document must be closed even when the query itself failed'
  );

  // findElementByValue 会把错误吞掉返回 null（自愈失败、下次重试是正确行为），
  // 但关闭时机同样不能因为吞错而丢失。
  offscreenOpen = false;
  const heal = await context.findElementByValue('https://ex.test/', '<p>x</p>', 'x', 'text');
  assert.equal(heal, null, 'findElementByValue swallows the failure and reports no selector');
  while (offscreenOpen) {
    const before = vTimers.size;
    assert.ok(pumpOneTimer(), 'a close timer must be pending after a failed self-heal');
    if (vTimers.size === before) break;
  }
  assert.equal(
    offscreenOpen,
    false,
    'the offscreen document must be closed even when self-healing failed'
  );
  chrome.runtime.sendMessage = realSendMessage;

  stopClock();
  console.log('background-review tests passed');
}

test().catch((error) => {
  // 时钟泵用的是 setImmediate 递归，不停掉的话失败时进程不会退出。
  stopClock();
  console.error(error);
  process.exitCode = 1;
});
// 跨 realm：vm 内创建的对象原型与本 realm 不同，strict deepEqual 会拒，先归一化。
const plain = (value) => JSON.parse(JSON.stringify(value));
