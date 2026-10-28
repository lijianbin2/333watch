const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert");

// 回归：一键打开全部未读 open-unread-urls
// 同一网页多条未读只开一次；pending、测试地址、无地址不打开；打开后按网址标已读。
const backgroundPath = path.join(__dirname, "..", "background.js");
const source = fs.readFileSync(backgroundPath, "utf8");

const syncStore = new Map();
const listeners = { runtime: [] };
const createdTabs = [];
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
const chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => listeners.runtime.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    sendMessage: async () => ({ ok: false }),
  },
  offscreen: {
    hasDocument: async () => true,
    createDocument: async () => {},
    closeDocument: async () => {},
  },
  notifications: {
    onClicked: { addListener: () => {} },
    create: (_id, _options, callback) => { callback("x"); },
    clear: async () => true,
  },
  tabs: {
    create: async (opts) => {
      createdTabs.push({ url: opts && opts.url, active: !!(opts && opts.active) });
      return { id: 1000 + createdTabs.length };
    },
    query: async () => [],
    sendMessage: async () => {},
  },
  storage: {
    sync: {
      get: async (key) => {
        if (key == null) return Object.fromEntries([...syncStore].map(([k, v]) => [k, clone(v)]));
        if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => syncStore.has(k)).map((k) => [k, clone(syncStore.get(k))]));
        return syncStore.has(key) ? { [key]: clone(syncStore.get(key)) } : {};
      },
      set: async (values) => { Object.entries(values).forEach(([k, v]) => syncStore.set(k, clone(v))); },
      remove: async (key) => { for (const k of (Array.isArray(key) ? key : [key])) syncStore.delete(k); },
      getBytesInUse: async () => 100,
    },
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
    onChanged: { addListener: () => {} },
  },
  action: {
    setBadgeBackgroundColor: async () => {},
    setBadgeText: async () => {},
  },
  alarms: {
    onAlarm: { addListener: () => {} },
    getAll: async () => [],
    get: async () => null,
    create: () => {},
    clear: async () => true,
  },
};
const context = vm.createContext({
  chrome,
  console,
  fetch: async () => { throw new Error("network disabled in unit test"); },
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
  setTimeout,
  clearTimeout,
});
vm.runInContext(source, context, { filename: backgroundPath });

function sendMessage(msg) {
  const handler = listeners.runtime[0];
  assert.equal(typeof handler, "function", "background must register an onMessage listener");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no response for " + msg.type)), 2000);
    const keep = handler(msg, {}, (res) => { clearTimeout(timer); resolve(res); });
    if (keep !== true) { clearTimeout(timer); resolve(undefined); }
  });
}
async function main() {
  const now = new Date().toISOString();
  syncStore.set("history", [
    { id: "u1", url: "https://example.com/a/", message: "a 变化", time: now, read: false },
    { id: "u2", url: "https://example.com/a", message: "a 又变化", time: now, read: false },
    { id: "u3", url: "https://example.com/b", message: "b 变化", time: now, read: false },
    { id: "r1", url: "https://example.com/c", message: "已读", time: now, read: true, readAt: Date.now() },
    { id: "p1", url: "https://example.com/d", message: "认领中", time: now, read: false, pending: true, claimAt: Date.now(), eventKey: "k1" },
    { id: "t1", url: "333-test://text", message: "测试", time: now, read: false },
    { id: "n1", url: "", message: "无地址", time: now, read: false },
  ]);
  const res = await sendMessage({ type: "open-unread-urls" });
  assert.equal(res.ok, true, "open-unread-urls must respond ok");
  assert.equal(res.opened, 2, "same page unread must open once");
  assert.equal(res.total, 2);
  assert.equal(res.updated, 3, "three unread items of opened pages must be marked read");
  assert.deepEqual(createdTabs.map((t) => t.url), ["https://example.com/a/", "https://example.com/b"]);
  assert.equal(createdTabs[0].active, true, "first tab must be active");
  assert.equal(createdTabs[1].active, false, "rest tabs must be background");
  const byId = Object.fromEntries(syncStore.get("history").map((h) => [h.id, h]));
  assert.equal(byId.u1.read, true);
  assert.equal(byId.u2.read, true);
  assert.equal(byId.u3.read, true);
  assert.equal(byId.p1.read, false, "pending claim must stay unread");
  assert.equal(byId.t1.read, false, "test url must stay unread");
  assert.equal(byId.n1.read, false, "empty url must stay unread");
  const res2 = await sendMessage({ type: "open-unread-urls" });
  assert.equal(res2.ok, true);
  assert.equal(res2.opened, 0, "no openable unread left");
  assert.equal(createdTabs.length, 2, "second call must not open more tabs");
  console.log("open-unread tests passed");
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });