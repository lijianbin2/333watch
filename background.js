/**
 * 333 Watcher - Background Service Worker (v0.6.14 - fix picker badge garble (-> 🎯))
 *
 * 监控类型：
 * - page：整页 HTML hash 对比
 * - link：下载链接监控（正则解析 a 标签，旧版方式，保留兼容）
 * - element：网页元素监控（offscreen document 解析 HTML + querySelector）
 */

const DEBUG = false; // 发布版关闭信息日志，调试时改为 true
function dbg(...args) { if (DEBUG) console.log(...args); }

const ALARM_PREFIX = 'monitor-';
const PRUNE_ALARM = '333-prune-history';
const _checkLock = new Set();
const DEFAULT_INTERVAL = 500;

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

async function savePickedMonitor(pick, attribute) {
  if (!pick || !pick.selector) {
    return { ok: false, error: '未获取到元素信息，请重新选择' };
  }
  const url = normalizeUrl(pick.pageUrl || '');
  if (!url) {
    return { ok: false, error: '无法获取当前网页地址' };
  }
  const attr = ['text', 'href', 'src'].includes(attribute) ? attribute : 'text';
  const name = (String(pick.text || pick.pageTitle || '指定内容').trim().slice(0, 60)) || '指定内容';
  const monitors = await getMonitors();
  // 同一网址只允许一个监控（避免重复通知），已有则更新
  const idx = monitors.findIndex((m) => normalizeUrl(m.url || '') === url);

  const lastValue = attributeValueOfPick(pick, attr);

  if (idx !== -1) {
    const old = monitors[idx];
    monitors[idx] = {
      ...old,
      name: name,
      url: url,
      type: 'element',
      selector: pick.selector,
      attribute: attr,
      lastValue: lastValue,
      lastHash: '',
      targetHref: '',
      targetText: '',
      updatedAt: Date.now()
    };
    await saveMonitors(monitors);
    dbg('[333 Watcher] picked monitor updated:', monitors[idx].id);
    return { ok: true, mode: 'updated', id: old.id };
  }

  const monitor = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name,
    url: url,
      interval: DEFAULT_INTERVAL,
    type: 'element',
    selector: pick.selector,
    attribute: attr,
    lastValue: lastValue,
    createdAt: new Date().toISOString(),
    updatedAt: Date.now(),
    lastHash: '',
    lastCheck: '',
    lastCheckTime: 0,
    nextCheckTime: 0
  };
  monitors.push(monitor);
  await saveMonitors(monitors);
  dbg('[333 Watcher] picked monitor added:', monitor.id);
  return { ok: true, mode: 'added', id: monitor.id };
}

function attributeValueOfPick(pick, attr) {
  if (attr === 'href') return pick.href || '';
  if (attr === 'src') return pick.src || '';
  return pick.text || '';
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
          interval: Math.max(1, Number(w.interval) || DEFAULT_INTERVAL),
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
      interval: Math.max(1, Number(m.interval) || DEFAULT_INTERVAL),
      type: m.type || 'page',
      selector: m.selector || '',
      attribute: m.attribute || '',
      targetHref: m.targetHref || '',
      targetText: m.targetText || '',
      lastValue: m.lastValue || '',
      createdAt: m.createdAt || new Date().toISOString(),
      updatedAt: m.updatedAt || 0,
      lastHash: m.lastHash || '',
      lastCheck: m.lastCheck || '',
      lastCheckTime: m.lastCheckTime || 0,
      nextCheckTime: m.nextCheckTime || 0
    };
  });

  // 去重：同一网址只保留一个监控（保留 updatedAt 最新的），避免重复通知
  const urlLatest = new Map();
  for (const m of normalized) {
    const key = normalizeUrl(m.url);
    if (!key) continue;
    const prev = urlLatest.get(key);
    const timeOf = (x) => Number(x.updatedAt) || new Date(x.createdAt).getTime() || 0;
    if (!prev || timeOf(m) > timeOf(prev)) urlLatest.set(key, m);
  }
  const deduped = normalized.filter((m) => {
    const key = normalizeUrl(m.url);
    return !!key && urlLatest.get(key) === m;
  });

  if (migrated || JSON.stringify(deduped) !== JSON.stringify(monitors)) {
    await saveMonitors(deduped);
    dbg('[333 Watcher] data migration done,', deduped.length, 'monitor(s)');
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
let _offscreenLock = null;
let _offscreenCloseTimer = null;
async function ensureOffscreen() {
  if (_offscreenLock) { try { await _offscreenLock; return; } catch {} }
  _offscreenLock = (async () => {
    try {
      let exists = false;
      try { exists = await chrome.offscreen.hasDocument(); } catch {}
      if (!exists) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['DOM_PARSER'],
          justification: 'Parse monitored page HTML to query monitored element'
        });
      }
    } catch (err) {
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
  })();
  try { await _offscreenLock; } finally { _offscreenLock = null; }
  if (_offscreenCloseTimer) { clearTimeout(_offscreenCloseTimer); _offscreenCloseTimer = null; }
}

function scheduleOffscreenClose() {
  if (_offscreenCloseTimer) clearTimeout(_offscreenCloseTimer);
  _offscreenCloseTimer = setTimeout(() => {
    chrome.offscreen.closeDocument().catch(() => {});
    _offscreenCloseTimer = null;
  }, 3000);
}

async function queryElementValue(html, selector, attribute) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    type: 'query-element',
    html: html,
    selector: selector,
    attribute: attribute
  });
  scheduleOffscreenClose();
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

// ---------------- 检测：json (微信开发者工具 config.json 专用) ----------------
function extractWechatVersion(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    const channels = data.channels || data.data || [];
    // 优先稳定版
    let ch = Array.isArray(channels) ? channels.find(c => c.id === "stable") : null;
    if (!ch && Array.isArray(channels) && channels.length) ch = channels[0];
    if (!ch) return null;
    // 返回版本号或完整下载链接，以“版本|链接”作为监控值，便于 diff
    const win = (ch.downloads || []).find(d => d.os === "Windows" && d.arch === "64") || (ch.downloads||[])[0];
    const ver = ch.version || "";
    const url = win ? win.url : "";
    return ver + "|" + url;
  } catch { return null; }
}
async function checkJson(monitor, text) {
  const cur = extractWechatVersion(text);
  if (!cur) {
    // 非预期 JSON，退化为 hash 对比
    return await checkPage(monitor, text);
  }
  const last = monitor.lastValue || null;
  const changed = last !== null && cur !== last;
  return { changed, prevValue: last, update: { lastValue: cur } };
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
  return { changed, prevValue: lastValue, update: { lastValue: currentHref } };
}

// ---------------- 检测：element ----------------
async function checkElement(monitor, html) {
  const attribute = monitor.attribute || 'text';
  const resp = await queryElementValue(html, monitor.selector, attribute);

  if ((!resp || !resp.ok) && monitor.lastValue) {
    // 选择器失效自愈：支持 text/href/src 按 lastValue 找回元素
    const found = await findElementByValue(monitor.url, html, monitor.lastValue, attribute);
    if (found && found.ok) {
      dbg('[333 Watcher] [element] selector healed:', found.selector, 'attr:', attribute);
      return { changed: false, update: { selector: found.selector }, healed: true };
    }
  }

  if (!resp || !resp.ok) {
    console.warn('[333 Watcher] [element] query failed:', resp && resp.error);
    return { changed: false, notFound: true, update: {} };
  }

  let current = resp.value;
  if ((attribute === 'href' || attribute === 'src') && current) {
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
  return { changed, prevValue: lastValue, update: { lastValue: current } };
}

// ---------------- 检测主流程 ----------------
// ---------------- 选择器自愈 / 二次确认 ----------------
async function findElementByValue(baseUrl, html, value, attribute) {
  try {
    await ensureOffscreen();
    const resp = await chrome.runtime.sendMessage({
      type: 'find-by-value',
      html: html,
      baseUrl: baseUrl,
      value: value,
      attribute: attribute || 'text'
    });
    scheduleOffscreenClose();
    return resp;
  } catch (err) {
    console.warn('[333 Watcher] findElementByValue failed:', err.message);
    return null;
  }
}

async function getCurrentValue(monitor, html) {
  if (monitor.type === 'element' && monitor.selector) {
    const attribute = monitor.attribute || 'text';
    const resp = await queryElementValue(html, monitor.selector, attribute);
    if (!resp || !resp.ok) return { ok: false };
    let v = resp.value;
    if ((attribute === 'href' || attribute === 'src') && v) {
      try { v = new URL(v, monitor.url).href; } catch {}
    }
    return { ok: true, value: v };
  }
  const links = extractLinks(html, monitor.url);
  let target = null;
  if (monitor.targetText) {
    target = links.find((l) => l.text === monitor.targetText);
  }
  if (!target && monitor.targetHref) {
    target = links.find((l) => normalizeUrl(l.href) === normalizeUrl(monitor.targetHref));
  }
  if (!target) return { ok: false };
  return { ok: true, value: target.href };
}

// 变化二次确认：立即重新抓取一次页面，值仍为新值才判定为真实变化
// 目的：避免 CDN/A-B 测试/缓存抖动造成的误报
async function confirmChange(monitor, newValue) {
  try {
    const res = await fetch(monitor.url, { cache: 'no-store' });
    const html = await res.text();
    const cur = await getCurrentValue(monitor, html);
    if (!cur.ok) {
      dbg('[333 Watcher] confirm: element not found on re-fetch, keep notification');
      return { stable: true, value: newValue };
    }
    const stable = cur.value === newValue;
    dbg('[333 Watcher] confirm: first =', newValue, ' second =', cur.value, ' stable =', stable);
    return { stable: stable, value: cur.value };
  } catch (err) {
    console.warn('[333 Watcher] confirm fetch failed:', err.message);
    return { stable: true, value: newValue };
  }
}

async function checkMonitor(monitor) {
  if (_checkLock.has(monitor.id)) { dbg('[333 Watcher] check skipped (in-flight):', monitor.id); return 'locked'; }
  _checkLock.add(monitor.id);
  try {
  const checkedAt = new Date().toISOString();
  dbg('[333 Watcher] ---- check start ----');
  dbg('[333 Watcher] time:', checkedAt);
  dbg('[333 Watcher] type:', monitor.type || 'page');
  dbg('[333 Watcher] url:', monitor.url);

  // 硬校验：监控已被删除则直接跳过，避免删除后仍检查/通知
  const alive = await getMonitors();
  if (!alive.some((m) => m.id === monitor.id)) {
    dbg('[333 Watcher] monitor deleted, check skipped:', monitor.id);
    return 'deleted';
  }

  // 微信开发者工具下载页 SPA 特殊处理：直接监控 config.json
  const isWechatDownload = monitor.url.includes('developers.weixin.qq.com/miniprogram/dev/devtools/download') || monitor.url.includes('wechat_devtools');
  let html;
  let wechatJsonText = null;
  try {
    if (isWechatDownload) {
      const jsonUrls = [
        'https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json',
        'https://devtools.wxqcloud.qq.com.cn/WechatWebDev/release/config.json'
      ];
      for (const jurl of jsonUrls) {
        try {
          const jres = await fetch(jurl, { cache: 'no-store' });
          if (jres.ok) { wechatJsonText = await jres.text(); dbg('[333 Watcher] wechat json fetched', jurl); break; }
        } catch {}
      }
      if (!wechatJsonText) dbg('[333 Watcher] wechat json fetch failed, fallback to html');
    }
    const res = await fetch(monitor.url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    html = await res.text();
  } catch (err) {
    console.error('[333 Watcher] fetch failed:', monitor.url, err.message);
    // 记录错误到存储，供 UI 显示
    try {
      const list = await getMonitors();
      const i = list.findIndex((m) => m.id === monitor.id);
      if (i !== -1) {
        list[i] = { ...list[i], lastError: err.message || 'fetch failed', lastCheck: checkedAt, lastCheckTime: Date.now() };
        await saveMonitors(list);
      }
    } catch {}
    return 'error';
  }

  const type = monitor.type || 'page';
  let outcome;
  if (isWechatDownload && wechatJsonText) {
    outcome = await checkJson(monitor, wechatJsonText);
    // 兼容旧监控：若之前存的是文本/单链接，首次对接到 JSON 的 版本|链接 时不算作变更，只做自愈更新
    if (outcome && outcome.changed && monitor.lastValue && !String(monitor.lastValue).includes('|') && String(outcome.update.lastValue||'').includes('|')) {
      outcome.changed = false;
    }
    if (!outcome || outcome.notFound) {
      if (type === 'element') {
        if (!monitor.selector && (monitor.targetHref || monitor.targetText)) {
          outcome = await checkLink(monitor, html);
        } else {
          outcome = await checkElement(monitor, html);
        }
      } else {
        outcome = await checkJson(monitor, wechatJsonText);
      }
    }
  } else if (type === 'element') {
    if (!monitor.selector && (monitor.targetHref || monitor.targetText)) {
      outcome = await checkLink(monitor, html);
    } else {
      outcome = await checkElement(monitor, html);
    }
  } else if (type === 'link' || type === 'download') {
    outcome = await checkLink(monitor, html);
  } else if (type === 'json' || (html.trim().startsWith('{') && html.includes('"channels"'))) {
    outcome = await checkJson(monitor, html);
  } else {
    // 自动识别微信 config.json：即使 type 写 page 也能走 JSON 解析
    if (monitor.url.includes('config.json') || monitor.url.includes('wxqcloud')) {
      const maybe = extractWechatVersion(html);
      if (maybe) outcome = await checkJson(monitor, html);
      else outcome = await checkPage(monitor, html);
    } else {
      outcome = await checkPage(monitor, html);
    }
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
    nextCheckTime: nowTs + Math.max(1, Number(monitors[idx].interval) || DEFAULT_INTERVAL) * 60000,
    lastError: ''
  };
  await saveMonitors(monitors);

  if (outcome.changed) {
    const isValueType = type === 'element' || type === 'link' || type === 'download';
    if (isValueType) {
      const confirmRes = await confirmChange(monitors[idx], outcome.update.lastValue);
      if (!confirmRes.stable) {
        dbg('[333 Watcher] value unstable between two fetches, notification suppressed');
        monitors[idx] = { ...monitors[idx], lastValue: confirmRes.value };
        await saveMonitors(monitors);
        return 'flaky';
      }
    }
    await notifyChange(monitors[idx], {
      oldValue: outcome.prevValue,
      newValue: outcome.update.lastValue
    });
    return 'changed';
  }
  return 'unchanged';
  } finally { _checkLock.delete(monitor.id); }
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

async function notifyChange(monitor, change) {
  const notifId = 'notif-' + monitor.id;
  const title = '333 Watcher';
  const name = monitor.name || monitor.url;
  let message;
  if (monitor.type === 'link' || monitor.type === 'download') {
    message = '"' + name + '" 下载地址发生变化';
  } else if (monitor.type === 'element') {
    message = monitor.attribute === 'href'
      ? '"' + name + '" 链接地址发生变化'
      : '"' + name + '" 监控内容发生变化';
  } else {
    message = '"' + name + '" 页面发生变化';
  }
  if (change && change.newValue != null && (monitor.type || 'page') !== 'page') {
    const fmt = (v) => {
      const str = v == null || v === '' ? '(空)' : String(v);
      return str.length > 60 ? str.slice(0, 57) + '...' : str;
    };
    message += '\n旧: ' + fmt(change.oldValue) + '\n新: ' + fmt(change.newValue);
  }

  const result = await sendNotification(notifId, title, message);
  if (!result.ok) {
    console.error('[333 Watcher] 通知发送失败，error =', result.error);
  } else {
    // 写入通知历史（chrome.storage.sync，跨设备同步）
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

  if (msg.type === 'clear-read-history') {
    (async () => {
      try {
        const result = await clearReadHistory();
        await updateBadge();
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // 元素点选后直接在页面内保存（来自 picker.js 浮层）
  if (msg.type === 'save-element-monitor') {
    (async () => {
      try {
        const result = await savePickedMonitor(msg.pick, msg.attribute);
        sendResponse(result);
      } catch (err) {
        console.error('[333 Watcher] save picked monitor failed:', err);
        sendResponse({ ok: false, error: err.message || '保存失败' });
      }
    })();
    return true;
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
  await migrateHistoryToSync();
  await syncAlarms();
  await ensurePruneAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  dbg('[333 Watcher] startup');
  await migrateData();
  await migrateHistoryToSync();
  await syncAlarms();
  await ensurePruneAlarm();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.monitors) {
    syncAlarms().catch((err) => console.error('[333 Watcher] syncAlarms failed:', err));
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

dbg('[333 Watcher] Background service worker loaded (v0.6.14)');



// ================= 通知历史 + 角标（chrome.storage.sync，跨设备同步） =================
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 50; // storage.sync 容量有限，只保留最近 50 条
const HISTORY_MAX_BYTES = 7000; // storage.sync 单 key 上限 8KB，留出余量
const HISTORY_READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 已读通知保留 7 天后自动清理

function utf8Bytes(str) {
  return new TextEncoder().encode(str).length;
}

async function getHistory() {
  const data = await chrome.storage.sync.get(HISTORY_KEY);
  return Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
}

async function saveHistory(history) {
  let list = Array.isArray(history) ? history : [];
  list = list.slice(0, HISTORY_LIMIT);
  // 超长时优先丢弃最旧记录，避免写入超过 storage.sync 的 8KB 单 key 限制
  while (list.length > 1 && utf8Bytes(JSON.stringify(list)) > HISTORY_MAX_BYTES) {
    list = list.slice(0, -1);
  }
  await chrome.storage.sync.set({ [HISTORY_KEY]: list });
}

async function addHistory(record) {
  try {
    const history = await getHistory();
    const now = Date.now();
    const dedupWindow = 5 * 60 * 1000;
    const isDup = history.some(h => h.message === record.message && h.url === record.url && Math.abs(now - new Date(h.time).getTime()) < dedupWindow);
    if (isDup) { dbg('[333 Watcher] history dedup skipped:', record.message); return; }
    history.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: record.name,
      url: record.url,
      time: new Date().toISOString(),
      message: record.message,
      read: false
    });
    await saveHistory(history);
    dbg('[333 Watcher] history added:', record.message);
  } catch (err) {
    console.error('[333 Watcher] history add failed:', err);
  }
}

// 清理已读通知：超过保留期后自动删除，避免历史无限累积
async function pruneHistory() {
  try {
    const history = await getHistory();
    if (!history.length) return;
    const cutoff = Date.now() - HISTORY_READ_RETENTION_MS;
    const kept = history.filter((h) => {
      if (!h.read) return true;
      const readAt = Number(h.readAt) || new Date(h.time).getTime() || 0;
      return readAt >= cutoff;
    });
    if (kept.length !== history.length) {
      await saveHistory(kept);
      dbg('[333 Watcher] history pruned:', history.length - kept.length, 'read item(s)');
    }
  } catch (err) {
    console.error('[333 Watcher] history prune failed:', err);
  }
}

async function clearReadHistory() {
  try {
    const history = await getHistory();
    if (!history.length) return { removed: 0, kept: 0 };
    const kept = history.filter((h) => !h.read);
    const removed = history.length - kept.length;
    if (removed > 0) {
      await saveHistory(kept);
      dbg('[333 Watcher] clear read history:', removed, 'item(s)');
    }
    return { removed, kept: kept.length };
  } catch (err) {
    console.error('[333 Watcher] clear read history failed:', err);
    return { removed: 0, kept: 0, error: err.message };
  }
}

async function ensurePruneAlarm() {
  try {
    const existing = await chrome.alarms.get(PRUNE_ALARM);
    if (!existing || existing.periodInMinutes !== 60) {
      if (existing) await chrome.alarms.clear(PRUNE_ALARM);
      await chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60 });
      dbg('[333 Watcher] prune alarm scheduled every 60 min');
    }
  } catch (err) {
    console.error('[333 Watcher] ensurePruneAlarm failed:', err);
  }
}

// 旧版本历史存在本机 storage.local，启动时一次性合并进 sync，保证换电脑后已读状态同步
function mergeHistoryLists(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const h of list) {
      if (!h || typeof h !== 'object') continue;
      const id = String(h.id || '');
      const time = h.time || '';
      const text = String(h.message || h.name || '');
      const key = id || (time + '|' + text);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...h });
        continue;
      }
      const merged = { ...prev, ...h };
      merged.read = !!(prev.read || h.read);
      merged.readAt = h.readAt || prev.readAt || null;
      byKey.set(key, merged);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const ta = new Date(a.time).getTime() || 0;
    const tb = new Date(b.time).getTime() || 0;
    return tb - ta;
  });
}

async function migrateHistoryToSync() {
  try {
    const localData = await chrome.storage.local.get(HISTORY_KEY);
    const localHistory = Array.isArray(localData[HISTORY_KEY]) ? localData[HISTORY_KEY] : [];
    if (!localHistory.length) return;
    const syncData = await chrome.storage.sync.get(HISTORY_KEY);
    const syncHistory = Array.isArray(syncData[HISTORY_KEY]) ? syncData[HISTORY_KEY] : [];
    const merged = mergeHistoryLists(syncHistory, localHistory);
    if (!merged.length) return;
    await saveHistory(merged);
    await chrome.storage.local.remove(HISTORY_KEY);
    dbg('[333 Watcher] history migrated local -> sync:', merged.length, 'item(s)');
  } catch (err) {
    console.error('[333 Watcher] history migration failed:', err);
  }
}

async function updateBadge() {
  await pruneHistory();
  const history = await getHistory();
  const unread = history.filter((h) => !h.read).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' });
  await chrome.action.setBadgeText({ text: unread > 0 ? String(unread) : '' });
}

// 历史变化时自动刷新角标（含 popup 标记已读后的清零）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[HISTORY_KEY]) {
    updateBadge();
  }
});

chrome.runtime.onStartup.addListener(() => { updateBadge(); });
chrome.runtime.onInstalled.addListener(() => { updateBadge(); });
setTimeout(updateBadge, 0);
setTimeout(() => { try { ensurePruneAlarm(); } catch {} }, 1000);

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






