const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backgroundPath = path.join(__dirname, '..', 'background.js');
const source = fs.readFileSync(backgroundPath, 'utf8');
const listeners = { runtime: [], notifications: [], storage: [], alarms: [] };
const syncStore = new Map();
let notificationCount = 0;

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
        if (key == null) return Object.fromEntries(syncStore);
        if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => syncStore.has(k)).map((k) => [k, syncStore.get(k)]));
        return syncStore.has(key) ? { [key]: syncStore.get(key) } : {};
      },
      set: async (values) => Object.entries(values).forEach(([key, value]) => syncStore.set(key, value)),
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
