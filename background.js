/**
 * 333 Watcher - Background Service Worker (v0.5)
 *
 * 监控类型：
 * - page：整页 HTML hash 对比
 * - link：下载链接监控（正则解析 a 标签，旧版方式，保留兼容）
 * - element：网页元素监控（offscreen document 解析 HTML + querySelector）
 */

const DEBUG = false; // 发布版关闭信息日志，调试时改为 true
function dbg(...args) { if (DEBUG) console.log(...args); }

const ALARM_PREFIX = 'monitor-';

// ---------------- 工具 ----------------
function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function normalizeUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// SW 无 DOMParser，link 类型用正则提取 <a>
function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[2].trim();
    const text = stripTags(m[3]);
    if (!href || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('mailto:')) continue;
    try {
      href = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    links.push({ href, text });
  }
  return links;
}

// ---------------- 存储（仅使用 chrome.storage.sync） ----------------
async function getMonitors() {
  const { monitors = [] } = await chrome.storage.sync.get('monitors');
  return monitors;
}

async function saveMonitors(monitors) {
  await chrome.storage.sync.set({ monitors });
}

// ---------------- 数据迁移 ----------------
async function migrateData() {
  const data = await chrome.storage.sync.get(null);
  let monitors = Array.isArray(data.monitors) ? data.monitors : [];
  let migrated = false;

  if (Array.isArray(data.watchers)) {
    for (const w of data.watchers) {
      const url = normalizeUrl(w.url);
      if (!url) continue;
      if (!monitors.some((m) => normalizeUrl(m.url) === url)) {
        monitors.push({
          id: w.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
          name: w.name || w.url,
          url: url,
          interval: Math.max(1, Number(w.interval) || 1000),
          type: 'page',
          createdAt: w.createdAt || new Date().toISOString()
        });
        migrated = true;
      }
    }
    await chrome.storage.sync.remove('watchers');
    dbg('[333 Watcher] migrated legacy watchers -> monitors');
  }

  const normalized = monitors.map((m) => {
    // 兼容旧 type="link" / "download"：统一转为指定内容监控，链接地址
    if (m.type === 'link' || m.type === 'download') {
      m.type = 'element';
      m.attribute = 'href';
      if (!m.selector && m.targetHref) {
        // 旧 link 数据没有 selector，保留 targetHref 用于后台回退检测
        m.selector = '';
      }
      if (!m.lastValue && m.targetHref) {
        m.lastValue = m.targetHref;
      }
    }
    return {
      id: m.id,
      name: m.name || m.url,
      url: normalizeUrl(m.url),
      interval: Math.max(1, Number(m.interval) || 1000),
      type: m.type || 'page',
      selector: m.selector || '',
      attribute: m.attribute || '',
      targetHref: m.targetHref || '',
      targetText: m.targetText || '',
      lastValue: m.lastValue || '',
      createdAt: m.createdAt || new Date().toISOString(),
      lastHash: m.lastHash || '',
      lastCheck: m.lastCheck || '',
      lastCheckTime: m.lastCheckTime || 0,
      nextCheckTime: m.nextCheckTime || 0
    };
  });

  if (migrated || JSON.stringify(normalized) !== JSON.stringify(monitors)) {
    await saveMonitors(normalized);
    dbg('[333 Watcher] data migration done,', normalized.length, 'monitor(s)');
  }
}

// ---------------- Alarm 调度 ----------------
function alarmName(id) {
  return ALARM_PREFIX + id;
}

async function syncAlarms() {
  const monitors = await getMonitors();
  const alarms = await chrome.alarms.getAll();
  const wanted = new Set(monitors.map((m) => alarmName(m.id)));

  for (const m of monitors) {
    const name = alarmName(m.id);
    const existing = alarms.find((a) => a.name === name);
    const period = Math.max(1, Number(m.interval) || 1);
    if (!existing || existing.periodInMinutes !== period) {
      // 尊重 nextCheckTime：电脑关机/休眠后不会重新计时
      const now = Date.now();
      const next = Number(m.nextCheckTime) || 0;
      const delayMin = next > now ? Math.max(0.5, (next - now) / 60000) : 0.5;
      chrome.alarms.create(name, {
        delayInMinutes: Math.min(delayMin, period),
        periodInMinutes: period
      });
      dbg('[333 Watcher] Alarm scheduled:', name, 'every', period, 'min');
    }
  }

  for (const a of alarms) {
    if (a.name.startsWith(ALARM_PREFIX) && !wanted.has(a.name)) {
      await chrome.alarms.clear(a.name);
      dbg('[333 Watcher] Alarm removed:', a.name);
    }
  }
}

// ---------------- Offscreen DOM 查询（element 类型用） ----------------
async function ensureOffscreen() {
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Parse monitored page HTML to query monitored element'
      });
    }
  } catch (err) {
    // hasDocument 不存在或文档已存在等异常情况，尝试直接创建
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Parse monitored page HTML to query monitored element'
      });
    } catch (e) {
      console.warn('[333 Watcher] offscreen setup:', e.message);
    }
  }
}

async function queryElementValue(html, selector, attribute) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    type: 'query-element',
    html: html,
    selector: selector,
    attribute: attribute
  });
  chrome.offscreen.closeDocument().catch(() => {});
  return resp;
}

// ---------------- 检测：page ----------------
async function checkPage(monitor, html) {
  const newHash = simpleHash(html);
  const oldHash = monitor.lastHash || null;
  const changed = oldHash !== null && newHash !== oldHash;
  dbg('[333 Watcher] [page] oldHash:', oldHash, 'newHash:', newHash, 'changed:', changed);
  return { changed, update: { lastHash: newHash } };
}

// ---------------- 检测：link（旧版，兼容保留） ----------------
async function checkLink(monitor, html) {
  const links = extractLinks(html, monitor.url);
  dbg('[333 Watcher] [link] extracted', links.length, 'links');

  let target = null;
  if (monitor.targetText) {
    target = links.find((l) => l.text === monitor.targetText);
  }
  if (!target && monitor.targetHref) {
    target = links.find((l) => normalizeUrl(l.href) === normalizeUrl(monitor.targetHref));
  }

  if (!target) {
    console.warn('[333 Watcher] [link] target link NOT FOUND');
    return { changed: false, notFound: true, update: {} };
  }

  const currentHref = target.href;
  const lastValue = monitor.lastValue || null;
  const changed = lastValue !== null && currentHref !== lastValue;
  dbg('[333 Watcher] [link] lastValue:', lastValue, 'currentHref:', currentHref, 'changed:', changed);
  return { changed, update: { lastValue: currentHref } };
}

// ---------------- 检测：element ----------------
async function checkElement(monitor, html) {
  const attribute = monitor.attribute || 'text';
  const resp = await queryElementValue(html, monitor.selector, attribute);

  if (!resp || !resp.ok) {
    console.warn('[333 Watcher] [element] query failed:', resp && resp.error);
    return { changed: false, notFound: true, update: {} };
  }

  let current = resp.value;
  if (attribute === 'href' && current) {
    try {
      current = new URL(current, monitor.url).href; // 相对路径转绝对
    } catch {}
  }

  const lastValue = monitor.lastValue || null;
  const changed = lastValue !== null && current !== lastValue;
  dbg('[333 Watcher] [element] selector:', monitor.selector);
  dbg('[333 Watcher] [element] attribute:', attribute);
  dbg('[333 Watcher] [element] lastValue:', lastValue);
  dbg('[333 Watcher] [element] current:', current);
  dbg('[333 Watcher] [element] changed:', changed);
  return { changed, update: { lastValue: current } };
}

// ---------------- 检测主流程 ----------------
async function checkMonitor(monitor) {
  const checkedAt = new Date().toISOString();
  dbg('[333 Watcher] ---- check start ----');
  dbg('[333 Watcher] time:', checkedAt);
  dbg('[333 Watcher] type:', monitor.type || 'page');
  dbg('[333 Watcher] url:', monitor.url);

  let html;
  try {
    const res = await fetch(monitor.url, { cache: 'no-store' });
    html = await res.text();
  } catch (err) {
    console.error('[333 Watcher] fetch failed:', monitor.url, err.message);
    return 'error';
  }

  const type = monitor.type || 'page';
  let outcome;
  if (type === 'element') {
    if (!monitor.selector && (monitor.targetHref || monitor.targetText)) {
      outcome = await checkLink(monitor, html);
    } else {
      outcome = await checkElement(monitor, html);
    }
  } else if (type === 'link' || type === 'download') {
    outcome = await checkLink(monitor, html);
  } else {
    outcome = await checkPage(monitor, html);
  }

  if (outcome.notFound) {
    return 'not-found';
  }

  const monitors = await getMonitors();
  const idx = monitors.findIndex((m) => m.id === monitor.id);
  if (idx === -1) return 'error';

  const nowTs = Date.now();
  monitors[idx] = {
    ...monitors[idx],
    ...outcome.update,
    lastCheck: checkedAt,
    lastCheckTime: nowTs,
    nextCheckTime: nowTs + Math.max(1, Number(monitors[idx].interval) || 1) * 60000
  };
  await saveMonitors(monitors);

  if (outcome.changed) {
    await notifyChange(monitors[idx]);
    return 'changed';
  }
  return 'unchanged';
}

// ---------------- 通知（带诊断） ----------------
function sendNotification(notifId, title, message) {
  return new Promise((resolve) => {
    const options = {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: message,
      priority: 2
    };
    dbg('[333 Watcher] notifications.create ->', notifId, JSON.stringify(options));

    chrome.notifications.create(notifId, options, (notificationId) => {
      if (chrome.runtime.lastError) {
        console.error('[333 Watcher] notification FAILED. lastError:', chrome.runtime.lastError.message);
        resolve({ ok: false, notificationId: null, error: chrome.runtime.lastError.message });
      } else {
        dbg('[333 Watcher] notification created OK, notificationId:', notificationId);
        resolve({ ok: true, notificationId: notificationId, error: null });
      }
    });
  });
}

async function notifyChange(monitor) {
  const notifId = 'notif-' + monitor.id;
  const title = '333 Watcher';
  const name = monitor.name || monitor.url;
  let message;
  if (monitor.type === 'link') {
    message = '"' + name + '" 下载地址发生变化';
  } else if (monitor.type === 'element') {
    message = monitor.attribute === 'href'
      ? '"' + name + '" 链接地址发生变化'
      : '"' + name + '" 监控内容发生变化';
  } else {
    message = '"' + name + '" 页面发生变化';
  }

  const result = await sendNotification(notifId, title, message);
  if (!result.ok) {
    console.error('[333 Watcher] 通知发送失败，error =', result.error);
  } else {
    // 写入通知历史（chrome.storage.local）
    await addHistory({
      name: monitor.name || monitor.url,
      url: monitor.url,
      message: message
    });
  }
  return result;
}

chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith('notif-')) return;
  if (notifId.startsWith('notif-picked-')) {
    chrome.notifications.clear(notifId);
    return;
  }
  const monitorId = notifId.slice('notif-'.length);
  const monitors = await getMonitors();
  const monitor = monitors.find((m) => m.id === monitorId);
  if (monitor) {
    chrome.tabs.create({ url: monitor.url });
  }
  chrome.notifications.clear(notifId);
});

// ---------------- 消息处理 ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'check-now') {
    (async () => {
      const monitors = await getMonitors();
      const monitor = monitors.find((m) => m.id === msg.id);
      if (!monitor) {
        sendResponse({ ok: false, error: 'monitor not found' });
        return;
      }
      const result = await checkMonitor(monitor);
      sendResponse({ ok: result !== 'error', result: result });
    })();
    return true;
  }

  if (msg.type === 'test-notification') {
    (async () => {
      const result = await sendNotification(
        'notif-test-' + Date.now(),
        '333 Watcher测试',
        '通知功能正常。'
      );
      sendResponse(result);
    })();
    return true;
  }

  // 元素选择完成（来自 picker.js）
  if (msg.type === 'element-picked') {
    sendNotification(
      'notif-picked-' + Date.now(),
      '333 Watcher',
      '元素已选择，点击扩展图标完成保存'
    );
    return;
  }
});

// ---------------- 事件入口 ----------------
chrome.runtime.onInstalled.addListener(async (details) => {
  dbg('[333 Watcher] installed:', details.reason);
  const data = await chrome.storage.sync.get('monitors');
  if (!Array.isArray(data.monitors)) {
    await chrome.storage.sync.set({ monitors: [] });
  }
  await migrateData();
  await syncAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  dbg('[333 Watcher] startup');
  await migrateData();
  await syncAlarms();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.monitors) {
    syncAlarms();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const monitorId = alarm.name.slice(ALARM_PREFIX.length);
  const monitors = await getMonitors();
  const monitor = monitors.find((m) => m.id === monitorId);
  if (monitor) {
    await checkMonitor(monitor);
  }
});

dbg('[333 Watcher] Background service worker loaded (v0.5)');



// ================= 通知历史 + 角标（chrome.storage.local） =================
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 100;

async function getHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
}

async function addHistory(record) {
  const history = await getHistory();
  history.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: record.name,
    url: record.url,
    time: new Date().toISOString(),
    message: record.message,
    read: false
  });
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, HISTORY_LIMIT) });
  dbg('[333 Watcher] history added:', record.message);
}

async function updateBadge() {
  const history = await getHistory();
  const unread = history.filter((h) => !h.read).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' });
  await chrome.action.setBadgeText({ text: unread > 0 ? String(unread) : '' });
}

// 历史变化时自动刷新角标（含 popup 标记已读后的清零）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[HISTORY_KEY]) {
    updateBadge();
  }
});

chrome.runtime.onStartup.addListener(() => { updateBadge(); });
chrome.runtime.onInstalled.addListener(() => { updateBadge(); });
setTimeout(updateBadge, 0);

// ================= 启动补检 =================
// Chrome 启动时：超过 nextCheckTime 的任务立即检查（关机期间不重置计时）
async function catchUpChecks() {
  const monitors = await getMonitors();
  const now = Date.now();
  for (const m of monitors) {
    const next = Number(m.nextCheckTime) || 0;
    if (next <= now) {
      dbg('[333 Watcher] catch-up check (overdue):', m.url);
      await checkMonitor(m);
    }
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await catchUpChecks();
});



