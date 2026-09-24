const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backgroundPath = path.join(__dirname, '..', 'background.js');
const source = fs.readFileSync(backgroundPath, 'utf8');
const listeners = { runtime: [], notifications: [], storage: [], alarms: [] };
const syncStore = new Map();

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
    create: (_id, _options, callback) => callback('test-notification'),
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
  setTimeout: () => 0,
  clearTimeout: () => {},
});
vm.runInContext(source, context, { filename: backgroundPath });

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

  syncStore.clear();
  syncStore.set('history', [{ url: eventBase.url, message: first.message, read: true }]);
  assert.equal(await context.hasReadEvent(first), true, 'legacy read history should suppress a matching event');
  syncStore.set('history', [{ url: eventBase.url, message: first.message, eventKey: first.eventKey, read: true }]);
  assert.equal(await context.hasReadEvent(first), true, 'read event key should suppress the same event');
  assert.equal(await context.hasReadEvent(next), false, 'a new sequence must remain notifyable');
  syncStore.set('history', [{ url: eventBase.url, message: first.message, eventKey: first.eventKey, read: false }]);
  assert.equal(await context.hasReadEvent(first), false, 'unread history must not suppress a notification');

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
