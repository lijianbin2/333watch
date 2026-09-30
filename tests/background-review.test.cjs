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
  syncStore.set('history', [{
    id: 'stale-claim',
    url: eventBase.url,
    message: first.message,
    eventKey: first.eventKey,
    claimAt: Date.now() - 10 * 60 * 1000,
    pending: true,
    read: false
  }]);
  const staleClaimNotify = await context.notifyOnce(first, notifyRecord, 'notif-page-1', '333 Watcher');
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

  // 页面侧新增去重读的是旧快照：并发下可能撞上同 key，background 必须兜底不建重复项。
  const dupeBackstop = plain(await sendMessage({
    type: 'mutate-monitors',
    op: 'upsert',
    monitor: { id: 'p9-fresh-id', url: 'https://example.test/1', type: 'page', name: 'raced' },
  }));
  assert.equal(dupeBackstop.mode, 'updated', 'an upsert colliding on monitorKey must update, not duplicate');
  assert.equal(dupeBackstop.id, 'p1', 'the colliding upsert must keep the existing monitor id');
  assert.equal(syncStore.get('monitors').length, 5, 'a colliding upsert must not add a row');
  assert.equal(
    syncStore.get('monitors').find((m) => m.id === 'p1').name,
    'raced',
    'a colliding upsert must apply the new definition'
  );

  const bad = await sendMessage({ type: 'mutate-monitors', op: 'nope' });
  assert.equal(bad.ok, false, 'an unknown op must be rejected');
  assert.equal(syncStore.get('monitors').length, 5, 'an unknown op must not write');

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
