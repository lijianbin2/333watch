const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backgroundPath = path.join(__dirname, '..', 'background.js');
const source = fs.readFileSync(backgroundPath, 'utf8');
const listeners = { runtime: [], notifications: [], storage: [], alarms: [] };
const syncStore = new Map();
let notificationCount = 0;
// 结构化克隆：真实 chrome.storage 读出的是副本，读写不共享引用。
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

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
      get: async () => ({}),
      remove: async () => {},
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
  Date,
  Set,
  Map,
  Number,
  String,
  Math,
  JSON,
  Array,
  Object,
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout: () => {},
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

  console.log('background-review tests passed');
}

test().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
