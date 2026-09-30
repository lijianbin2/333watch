/**
 * 333 Watcher - Background Service Worker (v0.6.39 - monitor id 全入口唯一化)
 *
 * 监控类型：
 * - page：整页 HTML hash 对比
 * - link：下载链接监控（正则解析 a 标签，旧版方式，保留兼容）
 * - element：网页元素监控（offscreen document 解析 HTML + querySelector）
 */

const DEBUG = false; // 发布版关闭信息日志，调试时改为 true
function dbg(...args) { if (DEBUG) console.log(...args); }

const TEST_URL_PREFIX = '333-test://';
const TEST_STORAGE_KEY_TEXT = '_333_test_text';
const TEST_STORAGE_KEY_HREF = '_333_test_href';
const TEST_STORAGE_KEY_LEGACY = '_333_test_value';
const TEST_STORAGE_KEY = TEST_STORAGE_KEY_LEGACY; // legacy compat
const ALARM_PREFIX = 'monitor-';
const PRUNE_ALARM = '333-prune-history';
const _checkLock = new Set();
const _pendingNotificationKeys = new Set();
const DEFAULT_INTERVAL = 500;
const INVALID_THRESHOLD = 2;
const FETCH_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 2.5 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_TEXT_VALUE_CHARS = 4096;
const MAX_URL_VALUE_CHARS = 2048;
// 跨设备通知仲裁窗口。storage.sync 是最终一致的：两台设备几乎同时命中同一次变化时，
// 各自的认领写入要经过同步传播才能互相看见。窗口太短（原来的固定 600ms）时，
// 两边都只看到"自己的认领"，于是各发一条一模一样的通知。
// 检测到存在其他设备时才用长窗口；单设备用户走 600ms 快速路径，不牺牲通知时效。
const CLAIM_WINDOW_MULTI_MS = 5000;
const CLAIM_WINDOW_SINGLE_MS = 600;
const CLAIM_POLL_MS = 250;
const DEVICE_ID_KEY = '_333_device_id';

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

function monitorKey(monitor) {
  const url = normalizeUrl(monitor && monitor.url || '');
  const type = (monitor && monitor.type) || 'page';
  if (type === 'page') return 'page|' + url;
  const selector = (monitor && monitor.selector) || '';
  const attribute = (monitor && monitor.attribute) || 'text';
  // 旧版链接监控没有 selector，区分目标全靠 targetHref/targetText。
  // 不把它们算进 key，同一页面上两条指向不同下载地址的旧监控 key 完全相同：
  // 导入/去重时后者覆盖前者，用户备份里的监控凭空少一条。
  if (!selector) {
    return 'element|' + url + '|' + (monitor.targetHref || '') + '|' + (monitor.targetText || '') + '|' + attribute;
  }
  return 'element|' + url + '|' + selector + '|' + attribute;
}

function limitMonitorValue(value, attribute) {
  const text = value == null ? '' : String(value);
  const max = (attribute === 'href' || attribute === 'src') ? MAX_URL_VALUE_CHARS : MAX_TEXT_VALUE_CHARS;
  return text.length > max ? text.slice(0, max) : text;
}

function clampInterval(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback || DEFAULT_INTERVAL;
  return Math.min(10080, Math.max(1, Math.round(n)));
}

function nextEventSequence(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(2147483647, Math.floor(n) + 1);
}

// 监控 id 唯一化入口。id 同时充当 alarm 名、通知 id 和检查锁的键，
// 所以必须集中生成，别处不要自己拼 Date.now()+random。
function mintMonitorId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 保证整张监控表的 id 非空且互不相同，原地返回同一批对象。
 *
 * id 同时充当 alarm 名（ALARM_PREFIX+id）、通知 id 和检查锁的键，所以一旦重复：
 *   - 两条监控共用一个 alarm，syncAlarms 只建得出一个 → 其中一条再也不会被检查；
 *   - 通知 id 相同 → 后一条直接顶掉前一条，用户看到"少了一条提醒"；
 *   - findIndex(m.id === ...) 永远只命中第一条 → 基线写到错的监控上。
 *
 * 三个入口（导入合并 / 启动迁移 / 新增监控）都要过这道闸，缺一个就留下缺口：
 * 只有导入去重的话，旧版本已经写坏的表永远不会被修复。
 */
function ensureUniqueMonitorIds(list) {
  const used = new Set();
  const repaired = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') { repaired.push(m); continue; }
    const id = String(m.id || '');
    if (id && !used.has(id)) {
      used.add(id);
      repaired.push(m);
      continue;
    }
    const fresh = mintMonitorId();
    dbg('[333 Watcher] monitor id 空/重复，重新发号:', id || '(空)', '->', fresh);
    used.add(fresh);
    repaired.push({ ...m, id: fresh });
  }
  return repaired;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 事件基线字段：page 监控用 lastHash，其余类型用 lastValue。
function baselineFieldOf(type) {
  return type === 'page' ? 'lastHash' : 'lastValue';
}

function normalizedBaseline(value) {
  return value == null ? null : String(value);
}

/**
 * 被其他设备抢先记录时，丢弃本次抓取结果里的基线字段。
 *
 * 存储中的基线至少与我们开始检查时的快照一样新；若直接写入我们抓到的值，
 * 而这次抓取又恰好更新（另一台设备写入之后页面再次变化），该变化会被静默吞掉。
 * 保留存储中的基线，下一轮检查仍会正常检测到这次变化，只是晚一个周期。
 */
function updateWithoutSupersededBaseline(outcome, storedMonitor) {
  if (!outcome || !outcome.update) return outcome && outcome.update;
  const field = outcome.baseField || baselineFieldOf(storedMonitor.type);
  if (!field || !Object.prototype.hasOwnProperty.call(outcome.update, field)) {
    return outcome.update;
  }
  const kept = { ...outcome.update };
  delete kept[field];
  return kept;
}

/**
 * 判断本次检测所依据的基线是否已被其他设备（或本机更早的检查）推进。
 *
 * 检测用的是检查开始时读到的快照。若在提交前发现存储里的基线已经不是快照中的基线，
 * 说明同一变化已被别处记录并通知过，此时只同步状态、不再重复通知。
 */
function baselineSuperseded(outcome, storedMonitor) {
  if (!outcome || !outcome.changed) return false;
  const field = outcome.baseField || baselineFieldOf(storedMonitor.type);
  const detected = normalizedBaseline(outcome.baseValue);
  const stored = normalizedBaseline(storedMonitor[field]);
  return detected !== stored;
}

function stripHeavy(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('请求超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseText(response, maxBytes) {
  const limit = maxBytes || MAX_HTML_BYTES;
  const declared = Number(response.headers && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('响应内容过大');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw new Error('响应内容过大');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch {}
        throw new Error('响应内容过大');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// HTML 实体解码。picker 存基线时读的是真实 DOM 的 textContent / 已解析的
// a.href，实体早已解码；而这里只能正则解析 HTML 源码，实体仍是源码形态。
// 两侧形态不一致会让 targetText / targetHref 匹配**永远失败**：
//   <a href="/x?a=1&amp;b=2">AT&amp;T 下载</a>
// picker 存的是 "AT&T 下载" + "https://h/x?a=1&b=2"，
// extractLinks 过去给出 "AT&amp;T 下载" + "...&amp;b=2" → 匹配不上，
// 监控随即误报"页面已无此链接目标"并被标记为失效。
// 单次扫描同时匹配命名实体和数字实体，避免 "&amp;amp;" 被二次解码成 "&"。
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', middot: '·', bull: '•',
  times: '×', divide: '÷', deg: '°', laquo: '«', raquo: '»'
};
const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
function decodeEntities(text) {
  const s = String(text == null ? '' : text);
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (whole, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // 越界或非法码点一律保留原样：解码出一个替换字符只会让匹配更糟。
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // 代理区码点不是合法字符，同样保留原样。
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : whole;
  });
}

// 从属性串里取指定属性的值，支持带引号 / 无引号两种写法。
// 名字前的边界刻意不含 "-"，这样 data-href、xlink:href 不会被误当成 href。
const ATTR_RE_CACHE = {};
function attrValue(attrString, name) {
  let re = ATTR_RE_CACHE[name];
  if (!re) {
    re = ATTR_RE_CACHE[name] = new RegExp(
      '(?:^|[\\s"\'/])' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+))',
      'i'
    );
  }
  const m = re.exec(attrString || '');
  if (!m) return '';
  if (m[1] != null) return m[1].trim();
  if (m[2] != null) return m[2].trim();
  return (m[3] || '').trim();
}

// SW 无 DOMParser，link 类型用正则提取 <a>
// 标签头用整段属性捕获，引号里的 ">" 不会提前截断标签。
function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    // 必须在 new URL 之前解码：URL 解析不认 &amp;，解码后才是真实地址。
    let href = decodeEntities(attrValue(m[1], 'href'));
    const text = stripTags(m[2]);
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
  return Array.isArray(monitors) ? monitors : [];
}


async function getTestTextValue() {
  const d = await chrome.storage.sync.get([TEST_STORAGE_KEY_TEXT, TEST_STORAGE_KEY_LEGACY]);
  let v = d[TEST_STORAGE_KEY_TEXT];
  if (v == null || v === '' ) v = d[TEST_STORAGE_KEY_LEGACY];
  return (v == null || v === '') ? '初始文本 1' : String(v);
}
async function getTestHrefValue() {
  const d = await chrome.storage.sync.get(TEST_STORAGE_KEY_HREF);
  const v = d[TEST_STORAGE_KEY_HREF];
  return (v == null || v === '') ? 'https://example.com/file-v1.zip' : String(v);
}
async function getTestValue(attr) {
  if (attr === 'href') return getTestHrefValue();
  return getTestTextValue();
}
async function setTestTextValue(v) {
  await chrome.storage.sync.set({ [TEST_STORAGE_KEY_TEXT]: String(v) });
}
async function setTestHrefValue(v) {
  await chrome.storage.sync.set({ [TEST_STORAGE_KEY_HREF]: String(v) });
}
async function setTestValue(v, attr) {
  if (attr === 'href') return setTestHrefValue(v);
  return setTestTextValue(v);
}

function friendlyStorageError(err) {
  const message = String(err && err.message || err || '');
  if (/quota|max_write|quota_bytes|storage.*full/i.test(message)) {
    const friendly = new Error('Chrome 同步存储空间不足，请删除旧监控或减少监控内容后重试');
    friendly.code = 'SYNC_QUOTA';
    return friendly;
  }
  return err instanceof Error ? err : new Error(message || '同步存储失败');
}

async function saveMonitors(monitors) {
  try {
    await chrome.storage.sync.set({ monitors });
  } catch (err) {
    throw friendlyStorageError(err);
  }
}

// monitors 也是整键读-改-写：后台定时检查、popup 增删改、导入、迁移都可能同时动它，
// 后写者会整键覆盖先写者（丢监控，或把刚写入的检查基线回滚）。所有写入统一走这把
// 进程内互斥锁 + mutateMonitors()，保证“读-改-写”在同一临界区内完成。
let _monitorsLock = Promise.resolve();
function withMonitorsLock(fn) {
  const run = _monitorsLock.then(() => fn(), () => fn());
  _monitorsLock = run.then(() => {}, () => {});
  return run;
}

// mutator 直接修改传入的数组；返回 false 表示放弃本次写入（例如目标监控已被删除），
// 其余返回值原样透传给调用方。
async function mutateMonitors(mutator) {
  return withMonitorsLock(async () => {
    const list = await getMonitors();
    const result = await mutator(list);
    if (result === false) return { saved: false, result: undefined };
    await saveMonitors(list);
    return { saved: true, result };
  });
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
  const lastValue = attributeValueOfPick(pick, attr);
  // 读-改-写放进互斥区，避免与后台检查/popup 操作互相覆盖。
  const outcome = await mutateMonitors((monitors) => {
    // 同一页面可以监控多个不同元素；仅完全相同的目标才更新。
    const candidate = { type: 'element', url, selector: pick.selector, attribute: attr };
    const key = monitorKey(candidate);
    const idx = monitors.findIndex((m) => monitorKey(m) === key);

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
        updatedAt: Date.now(),
        eventSeq: Number(old.eventSeq) || 0,
        failCount: 0,
        lastError: '',
        invalid: false,
        invalidReason: '',
        invalidSince: null,
        baselined: false
      };
      return { mode: 'updated', id: old.id };
    }

    const monitor = {
      id: mintMonitorId(),
      name: name,
      url: url,
      interval: DEFAULT_INTERVAL,
      type: 'element',
      selector: pick.selector,
      attribute: attr,
      lastValue: lastValue,
      createdAt: new Date().toISOString(),
      updatedAt: Date.now(),
      eventSeq: 0,
      failCount: 0,
      lastError: '',
      invalid: false,
      invalidReason: '',
      invalidSince: null,
      baselined: false,
      lastHash: '',
      lastCheck: '',
      lastCheckTime: 0,
      nextCheckTime: 0
    };
    monitors.push(monitor);
    return { mode: 'added', id: monitor.id };
  });
  if (!outcome.saved) return { ok: false, error: '保存监控失败' };
  dbg('[333 Watcher] picked monitor ' + outcome.result.mode + ':', outcome.result.id);
  return { ok: true, mode: outcome.result.mode, id: outcome.result.id };
}

function attributeValueOfPick(pick, attr) {
  if (attr === 'href') return limitMonitorValue(pick.href || '', attr);
  if (attr === 'src') return limitMonitorValue(pick.src || '', attr);
  return limitMonitorValue(pick.text || '', attr);
}

// ---------------- 数据迁移 ----------------
// 迁移会整键重写 monitors，与后台检查/popup 写入并发时会把它们的改动整键覆盖掉，
// 因此整段放进 monitors 互斥区（内部直接用 saveMonitors，锁不可重入）。
async function migrateData() {
  return withMonitorsLock(migrateDataUnlocked);
}

async function migrateDataUnlocked() {
  const data = await chrome.storage.sync.get(null);
  let monitors = Array.isArray(data.monitors) ? data.monitors : [];
  let migrated = false;

  if (Array.isArray(data.watchers)) {
    for (const w of data.watchers) {
      const url = normalizeUrl(w.url);
      if (!url) continue;
      if (!monitors.some((m) => normalizeUrl(m.url) === url)) {
        // 旧 watchers 里的 id 可能和现有 monitors 撞车（同一份旧数据在多台
        // 机器上都存在时尤其容易）。撞车会让两条监控共用一个 alarm，
        // 其中一条再也不会被检查，基线还会写到错的记录上。
        const wantedId = w.id ? String(w.id) : '';
        const idTaken = wantedId && monitors.some((m) => String(m.id || '') === wantedId);
        monitors.push({
          id: idTaken ? mintMonitorId() : (wantedId || mintMonitorId()),
          name: w.name || w.url,
          url: url,
          interval: clampInterval(w.interval, DEFAULT_INTERVAL),
          type: 'page',
          createdAt: w.createdAt || new Date().toISOString()
        });
        migrated = true;
      }
    }
    dbg('[333 Watcher] migrated legacy watchers -> monitors');
  }

  const normalized = monitors.filter((m) => m && typeof m === 'object').map((m) => {
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
      interval: clampInterval(m.interval, DEFAULT_INTERVAL),
      type: m.type || 'page',
      selector: m.selector || '',
      attribute: m.attribute || '',
      targetHref: m.targetHref || '',
      targetText: m.targetText || '',
      lastValue: limitMonitorValue(m.lastValue || '', m.attribute || 'text'),
      createdAt: m.createdAt || new Date().toISOString(),
      updatedAt: m.updatedAt || 0,
      lastHash: m.lastHash || '',
      lastCheck: m.lastCheck || '',
      lastCheckTime: m.lastCheckTime || 0,
      nextCheckTime: m.nextCheckTime || 0,
      eventSeq: Math.max(0, Number(m.eventSeq) || 0),
      failCount: Math.max(0, Number(m.failCount) || 0),
      lastError: String(m.lastError || ''),
      invalid: m.invalid === true,
      invalidReason: String(m.invalidReason || ''),
      invalidSince: m.invalidSince || null,
      baselined: m.baselined !== false
    };
  });

  // 去重：整页监控按 URL，元素监控按 URL + selector + attribute。
  const keyLatest = new Map();
  for (const m of normalized) {
    const key = monitorKey(m);
    if (!normalizeUrl(m.url)) continue;
    const prev = keyLatest.get(key);
    const timeOf = (x) => Number(x.updatedAt) || new Date(x.createdAt).getTime() || 0;
    if (!prev || timeOf(m) > timeOf(prev)) keyLatest.set(key, m);
  }
  // id 也要在这里兜一道：导入去重只覆盖"导入那一刻"，而重复 id 可能早就被
  // 旧版本写进存储了（例如更早的 merge 按 URL 去重，把两条不同监控并成一条）。
  // 迁移在每次启动时都跑，把空/重复 id 修好，才能让 syncAlarms 真正为每条
  // 监控建出独立的 alarm，而不是让它们挤在同一个名字后面互相顶掉。
  const deduped = ensureUniqueMonitorIds(
    normalized.filter((m) => !!normalizeUrl(m.url) && keyLatest.get(monitorKey(m)) === m)
  );

  if (migrated || JSON.stringify(deduped) !== JSON.stringify(monitors)) {
    await saveMonitors(deduped);
    dbg('[333 Watcher] data migration done,', deduped.length, 'monitor(s)');
  }

  // 旧键必须等 monitors 真正写成功之后再删：saveMonitors 遇到配额不足会抛错，
  // 先删 watchers 会让旧数据无处可寻，等于把迁移失败变成数据丢失。
  if (Array.isArray(data.watchers)) {
    await chrome.storage.sync.remove('watchers');
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
    html: stripHeavy(html),
    selector: selector,
    attribute: attribute
  });
  scheduleOffscreenClose();
  return resp;
}

// ---------------- 检测：page ----------------
async function checkPage(monitor, html) {
  const newHash = simpleHash(stripHeavy(html));
  const oldHash = monitor.lastHash || null;
  const changed = oldHash !== null && newHash !== oldHash;
  dbg('[333 Watcher] [page] oldHash:', oldHash, 'newHash:', newHash, 'changed:', changed);
  return { changed, prevValue: oldHash, baseValue: oldHash, baseField: 'lastHash', update: { lastHash: newHash } };
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
  return { changed, prevValue: last, baseValue: last, baseField: 'lastValue', update: { lastValue: cur } };
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

  const currentHref = limitMonitorValue(target.href, 'href');
  const lastValue = monitor.lastValue == null ? null : limitMonitorValue(monitor.lastValue, 'href');
  const changed = lastValue !== null && currentHref !== lastValue;
  dbg('[333 Watcher] [link] lastValue:', lastValue, 'currentHref:', currentHref, 'changed:', changed);
  return { changed, prevValue: lastValue, baseValue: lastValue, baseField: 'lastValue', update: { lastValue: currentHref } };
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

  current = limitMonitorValue(current, attribute);
  const lastValue = monitor.lastValue == null ? null : limitMonitorValue(monitor.lastValue, attribute);
  // 兼容旧版拾取时截断 120 字符的基线：当前值以旧基线为前缀则视为未变，直接补全基线
  if (lastValue !== null && lastValue.length === 120 && current.startsWith(lastValue)) {
    return { changed: false, prevValue: lastValue, baseValue: lastValue, baseField: 'lastValue', update: { lastValue: current } };
  }
  const changed = lastValue !== null && current !== lastValue;
  dbg('[333 Watcher] [element] selector:', monitor.selector);
  dbg('[333 Watcher] [element] attribute:', attribute);
  dbg('[333 Watcher] [element] lastValue:', lastValue);
  dbg('[333 Watcher] [element] current:', current);
  dbg('[333 Watcher] [element] changed:', changed);
  return { changed, prevValue: lastValue, baseValue: lastValue, baseField: 'lastValue', update: { lastValue: current } };
}

// ---------------- 检测主流程 ----------------
// ---------------- 选择器自愈 / 二次确认 ----------------
async function findElementByValue(baseUrl, html, value, attribute) {
  try {
    await ensureOffscreen();
    const resp = await chrome.runtime.sendMessage({
      type: 'find-by-value',
      html: stripHeavy(html),
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
    return { ok: true, value: limitMonitorValue(v, attribute) };
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
  return { ok: true, value: limitMonitorValue(target.href, 'href') };
}

// 变化二次确认：立即重新抓取一次页面，值仍为新值才判定为真实变化
// 目的：避免 CDN/A-B 测试/缓存抖动造成的误报
async function confirmChange(monitor, newValue) {
  try {
    const res = await fetchWithTimeout(monitor.url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await readResponseText(res, MAX_HTML_BYTES);
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
  // 🧪 测试模式：虚拟 URL 不走网络，直接按 attribute 对比 storage 值 (v0.6.17 双路)
  if (monitor.url && monitor.url.startsWith(TEST_URL_PREFIX)) {
    if (_checkLock.has(monitor.id)) { dbg('[333 Watcher] check skipped (in-flight test):', monitor.id); return 'locked'; }
    _checkLock.add(monitor.id);
    try {
      const checkedAt = new Date().toISOString();
      const alive = await getMonitors();
      if (!alive.some((m) => m.id === monitor.id)) return 'deleted';
      const attr = monitor.attribute === 'href' ? 'href' : 'text';
      const cur = await getTestValue(attr);
      const last = (monitor.lastValue == null ? null : String(monitor.lastValue));
      const changed = last !== null && cur !== last;
      const firstBaseline = monitor.baselined === false;
      let saved = null;
      let superseded = false;
      try {
        const outcome = await mutateMonitors((list) => {
          const idx = list.findIndex((m) => m.id === monitor.id);
          if (idx === -1) return false;
          const nowTs = Date.now();
          superseded = baselineSuperseded(
            { changed: changed, baseValue: last, baseField: 'lastValue' },
            list[idx]
          );
          if (superseded) {
            dbg('[333 Watcher] test change already applied elsewhere, notification suppressed:', monitor.id);
          }
          const update = superseded
            ? updateWithoutSupersededBaseline({ baseField: 'lastValue', update: { lastValue: cur } }, list[idx])
            : { lastValue: cur };
          list[idx] = {
            ...list[idx],
            ...update,
            eventSeq: changed && !superseded ? nextEventSequence(list[idx].eventSeq) : (Number(list[idx].eventSeq) || 0),
            lastCheck: checkedAt,
            lastCheckTime: nowTs,
            nextCheckTime: nowTs + Math.max(1, Number(list[idx].interval) || 1) * 60000,
            lastError: '',
            failCount: 0,
            invalid: false,
            invalidReason: '',
            invalidSince: null,
            baselined: true
          };
          saved = { monitor: list[idx], superseded: superseded };
          return true;
        });
        if (!outcome.saved) return 'deleted';
      } catch (err) {
        // 基线没写进同步存储时绝不能发通知：下一轮会再次判定为变化并重试，
        // 现在通知只会造成一次无法追溯的误报。
        console.error('[333 Watcher] test check save failed:', monitor.id, err && err.message);
        return 'error';
      }
      if (firstBaseline) {
        dbg('[333 Watcher] first check baselined, notification suppressed:', monitor.id);
        return 'baselined';
      }
      if (changed && !superseded) {
        await safeNotify('change', saved.monitor, { oldValue: last, newValue: cur });
        return 'changed';
      }
      if (changed) return 'changed-elsewhere';
      return 'unchanged';
    } finally { _checkLock.delete(monitor.id); }
  }
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
          const jres = await fetchWithTimeout(jurl, { cache: 'no-store' });
          if (jres.ok) { wechatJsonText = await readResponseText(jres, MAX_JSON_BYTES); dbg('[333 Watcher] wechat json fetched', jurl); break; }
        } catch {}
      }
      if (!wechatJsonText) dbg('[333 Watcher] wechat json fetch failed, fallback to html');
    }
    const res = await fetchWithTimeout(monitor.url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    html = await readResponseText(res, MAX_HTML_BYTES);
  } catch (err) {
    console.error('[333 Watcher] fetch failed:', monitor.url, err.message);
    return await markCheckFailure(monitor.id, checkedAt, err.message || 'fetch failed', 'error');
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
    const reason = type === 'element'
      ? '页面已无此元素（选择器 ' + (monitor.selector || '(空)') + ' 自愈失败）'
      : '页面已无此链接目标';
    return await markCheckFailure(monitor.id, checkedAt, reason, 'not-found');
  }

  const monitors = await getMonitors();
  if (!monitors.some((m) => m.id === monitor.id)) return 'error';

  let saved = null;
  let wasInvalid = false;
  let firstBaseline = false;
  let superseded = false;
  try {
    const write = await mutateMonitors((list) => {
      const idx = list.findIndex((m) => m.id === monitor.id);
      if (idx === -1) return false;
      const nowTs = Date.now();
      wasInvalid = !!list[idx].invalid;
      firstBaseline = list[idx].baselined === false;
      superseded = baselineSuperseded(outcome, list[idx]);
      if (superseded) {
        dbg('[333 Watcher] change already recorded by another device, notification suppressed:', monitor.url);
      }
      const changeEventSeq = (outcome.changed && !superseded) ? nextEventSequence(list[idx].eventSeq) : (Number(list[idx].eventSeq) || 0);
      // 恢复事件也消耗一个序号，避免同一监控多次“失效 -> 恢复”被合并。
      const eventSeq = wasInvalid ? nextEventSequence(changeEventSeq) : changeEventSeq;
      const update = superseded
        ? updateWithoutSupersededBaseline(outcome, list[idx])
        : outcome.update;
      list[idx] = {
        ...list[idx],
        ...update,
        eventSeq,
        lastCheck: checkedAt,
        lastCheckTime: nowTs,
        nextCheckTime: nowTs + Math.max(1, Number(list[idx].interval) || DEFAULT_INTERVAL) * 60000,
        lastError: '',
        failCount: 0,
        invalid: false,
        invalidReason: '',
        invalidSince: null,
        baselined: true
      };
      saved = list[idx];
      return true;
    });
    if (!write.saved) return 'error';
  } catch (err) {
    // 基线未能落盘时不发通知：这一轮的变化会在下个周期重新检测到。
    console.error('[333 Watcher] check save failed:', monitor.id, err && err.message);
    return 'error';
  }
  if (wasInvalid) {
    await safeNotify('recovered', saved);
  }

  // 新建/重建监控的第一次成功检查只建立基线，不发变化通知
  if (firstBaseline) {
    dbg('[333 Watcher] first check baselined, notification suppressed:', monitor.id);
    return 'baselined';
  }

  if (outcome.changed && superseded) {
    return 'changed-elsewhere';
  }

  if (outcome.changed) {
    const isValueType = type === 'element' || type === 'link' || type === 'download';
    if (isValueType) {
      const confirmRes = await confirmChange(saved, outcome.update.lastValue);
      if (!confirmRes.stable) {
        dbg('[333 Watcher] value unstable between two fetches, notification suppressed');
        // 抖动回写的基线同样要走互斥区，否则会覆盖这期间的其他改动。
        try {
          await mutateMonitors((list) => {
            const idx = list.findIndex((m) => m.id === monitor.id);
            if (idx === -1) return false;
            // 只有基线仍是本轮刚写入的那个值时才回写：二次抓取期间别的设备/轮次
            // 可能已经把基线推进到更新的值（并已据此发过通知），此时回写会把基线
            // 倒回去，让这次变化被反复判定 —— 正是跨设备重复提醒的根因。
            const expected = normalizedBaseline(saved.lastValue);
            if (normalizedBaseline(list[idx].lastValue) !== expected) {
              dbg('[333 Watcher] flaky baseline superseded, skip write-back:', monitor.url);
              return false;
            }
            list[idx] = { ...list[idx], lastValue: confirmRes.value };
            return true;
          });
        } catch (err) {
          console.error('[333 Watcher] flaky baseline save failed:', monitor.id, err && err.message);
        }
        return 'flaky';
      }
    }
    await safeNotify('change', saved, {
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

function buildNotificationEvent(monitor, kind, message, details) {
  const values = details || {};
  const stableValue = [
    kind,
    monitorKey(monitor),
    String(values.oldValue == null ? '' : values.oldValue),
    String(values.newValue == null ? '' : values.newValue),
    String(values.reason == null ? '' : values.reason),
    String(values.sequence == null ? '' : values.sequence),
    String(message || '')
  ].join('\u001f');
  return {
    eventKey: 'v1-' + simpleHash(stableValue),
    url: monitor.url,
    message: message
  };
}

function isActiveClaim(h) {
  if (!h || !h.pending) return false;
  const age = Date.now() - (new Date(h.claimAt || h.time || 0).getTime() || 0);
  return age < 2 * 60 * 1000;
}

// ---------------- 设备心跳（只用于判断"是否多设备"，不参与去重本身） ----------------
const DEVICES_KEY = 'devices';
const DEVICE_HEARTBEAT_MS = 30 * 60 * 1000;  // 同一台设备最多每 30 分钟写一次心跳
const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;   // 超过 24 小时没心跳视为已卸载

/**
 * 本机稳定标识。放在 storage.local：storage.sync 会把它同步给所有设备，
 * 那样每台设备都会读到同一个值，也就分不出"自己"了。
 */
async function getDeviceId() {
  try {
    const data = await chrome.storage.local.get(DEVICE_ID_KEY);
    const existing = data && data[DEVICE_ID_KEY];
    if (existing) return String(existing);
    const created = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await chrome.storage.local.set({ [DEVICE_ID_KEY]: created });
    return created;
  } catch (err) {
    // 拿不到 deviceId 时返回一个进程内恒定值，宁可窗口判断失准也不让通知失败。
    if (!_fallbackDeviceId) _fallbackDeviceId = 'd-fallback-' + Date.now().toString(36);
    return _fallbackDeviceId;
  }
}
let _fallbackDeviceId = null;

/**
 * 刷新本机心跳，并返回"除本机外是否还有别的设备在用这个扩展"。
 * 这个结果只决定仲裁窗口长短，不参与通知去重；读改写竞争也无害。
 */
async function touchDeviceHeartbeat(deviceId) {
  try {
    const now = Date.now();
    const data = await chrome.storage.sync.get(DEVICES_KEY);
    const raw = (data[DEVICES_KEY] && typeof data[DEVICES_KEY] === 'object') ? data[DEVICES_KEY] : {};
    const map = {};
    let dropped = false;
    for (const id of Object.keys(raw)) {
      const ts = Number(raw[id]) || 0;
      if (now - ts < DEVICE_TTL_MS) map[id] = ts;
      else dropped = true;
    }
    const foreign = Object.keys(map).some((id) => id !== deviceId);
    const last = Number(map[deviceId]) || 0;
    // 心跳还新鲜且没有过期条目要清理时不必写，省掉绝大多数 sync 写入。
    if (now - last < DEVICE_HEARTBEAT_MS && !dropped) return foreign;
    map[deviceId] = now;
    await chrome.storage.sync.set({ [DEVICES_KEY]: map });
    return Object.keys(map).some((id) => id !== deviceId);
  } catch (err) {
    console.error('[333 Watcher] device heartbeat failed:', err && err.message);
    // 心跳写不进去（配额/离线）时按多设备处理：窗口拉长只会晚几秒，不会漏发。
    return true;
  }
}

/**
 * 跨设备认领仲裁。
 *
 * storage.sync 是最终一致的：两台设备几乎同时命中同一次变化时，A 的认领要经过
 * 同步传播才可能被 B 看见。原来固定等 600ms 就判定，传播稍慢时两边都只看到
 * 自己的认领，于是同一事件各发一条通知（用户表现为"换台电脑又收到一遍"）。
 * 现在改成在窗口内轮询：看到对手就立刻按全序仲裁决定输赢，没看到就一直等到窗口耗尽。
 */
async function arbitrateClaim(event, claimId) {
  const deviceId = await getDeviceId();
  const multiDevice = await touchDeviceHeartbeat(deviceId);
  const windowMs = multiDevice ? CLAIM_WINDOW_MULTI_MS : CLAIM_WINDOW_SINGLE_MS;
  const deadline = Date.now() + windowMs;
  for (;;) {
    const latest = await getHistory();
    const own = latest.find((h) => h && h.id === claimId);
    if (!own) {
      // 自己的认领已被清理或被别人整键覆盖：不能发，否则可能重复。
      return 'skip';
    }
    const rivals = rivalClaimsOf(event, latest, claimId);
    if (rivals.length) {
      const winner = pickClaimWinner([own, ...rivals]);
      if (!winner || winner.id !== claimId) {
        dbg('[333 Watcher] notification claim lost arbitration:', event.eventKey);
        return 'skip';
      }
      // 赢家无需等满窗口：对手会看到同样的全序结果并撤回自己的认领。
      return 'send';
    }
    // 对手已经赢下仲裁并投递完毕（pending:false, delivered:true）时，
    // 这条记录不能再算"活跃竞争者"，但它恰恰证明同一事件已经提醒过了。
    // storage.sync 传播要几百毫秒，而对手发完就立刻把 pending 置为 false，
    // 本机在窗口内读到的往往是"已投递"形态而非"认领中"形态。只看活跃认领
    // 会得出"无人竞争"的错误结论，等满窗口后再发一条一模一样的通知。
    // 认领成功与否只在 claimNotificationEvent 里查过一次 hasSeenEvent，
    // 仲裁阶段不复查，因此这里必须单独判定已投递。
    if (deliveredRivalClaimsOf(event, latest, claimId).length || await isEventDelivered(event.eventKey)) {
      dbg('[333 Watcher] notification already delivered on another device:', event.eventKey);
      return 'skip';
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'send';
    await waitMs(Math.min(CLAIM_POLL_MS, remaining));
  }
}

function hasSeenEvent(event, history) {
  return (Array.isArray(history) ? history : []).some(h => {
    if (!h) return false;
    if (event.eventKey && h.eventKey) {
      if (h.eventKey !== event.eventKey) return false;
      // 崩溃遗留的短期 pending 认领不应永久阻塞通知。
      return h.pending ? isActiveClaim(h) : true;
    }
    // 旧版本没有 eventKey，只对已读记录兼容匹配，避免误吞新的未读事件。
    return h.read === true && h.url === event.url && h.message === event.message;
  });
}

async function claimNotificationEvent(event, record) {
  return withHistoryLock(async () => {
    // 独立标记优先于 history 快照：history 记录上的 delivered 字段可能被另一台
    // 设备的撤回写覆盖掉，标记本身才是"已提醒过"的权威依据。
    if (await isEventDelivered(event && event.eventKey)) {
      return { claimed: false, reason: 'already-delivered' };
    }
    const history = await getHistory();
    if (hasSeenEvent(event, history)) {
      return { claimed: false, reason: 'already-recorded' };
    }
    const claim = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: record.name,
      url: record.url,
      time: new Date().toISOString(),
      claimAt: Date.now(),
      message: record.message,
      eventKey: event.eventKey,
      kind: record.kind || 'change',
      read: false,
      pending: true
    };
    await saveHistory([claim, ...history]);
    return { claimed: true, claimId: claim.id };
  });
}

/**
 * 同一 eventKey 出现多个并发认领时的确定性仲裁。
 *
 * storage.sync 是整键后写覆盖：若 B 在 A 写入之后才写入，B 的快照里已含 A 的认领，
 * 于是两条 pending 认领会同时存在；只判断“自己的认领还在”会让两台设备都发通知。
 * 这里按 claimAt、再按 id 做全序比较，所有设备算出同一个赢家，只有赢家发送。
 */
function pickClaimWinner(claims) {
  return claims.slice().sort((a, b) => {
    const ta = Number(a && a.claimAt) || 0;
    const tb = Number(b && b.claimAt) || 0;
    if (ta !== tb) return ta - tb;
    return String((a && a.id) || '') < String((b && b.id) || '') ? -1 : 1;
  })[0];
}

function rivalClaimsOf(event, history, claimId) {
  return (Array.isArray(history) ? history : []).filter(h => (
    h && h.eventKey === event.eventKey && h.id !== claimId && isActiveClaim(h)
  ));
}

/**
 * 同一 eventKey 下、别的设备已经投递完成的历史记录。
 *
 * 只认 delivered:true：completeNotificationClaim 在发送失败时会直接删除认领，
 * 所以留存在 history 里的非 pending 记录一定投递成功过。
 * pending 但已过期（崩溃遗留）的认领不算数，否则会永久吞掉这条提醒。
 */
function deliveredRivalClaimsOf(event, history, claimId) {
  return (Array.isArray(history) ? history : []).filter(h => (
    h && h.eventKey === event.eventKey && h.id !== claimId && !h.pending && h.delivered === true
  ));
}

async function getDeliveredEvents() {
  try {
    const data = await chrome.storage.sync.get(DELIVERED_KEY);
    const raw = data && data[DELIVERED_KEY];
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (err) {
    return {};
  }
}

/**
 * 这个 eventKey 是否已经被某台设备成功投递过。
 *
 * 仲裁阶段必须每次轮询都重读：storage.sync 传播要几百毫秒，
 * 对手的标记很可能在本机窗口过半之后才同步过来（和对手的认领一样，
 * 窗口内轮询才等得到）。
 */
async function isEventDelivered(eventKey) {
  if (!eventKey) return false;
  const map = await getDeliveredEvents();
  return Object.prototype.hasOwnProperty.call(map, eventKey);
}

/**
 * 记下"这个 eventKey 已经投递成功"，只有仲裁赢家会调用。
 *
 * 为什么不直接把 delivered 写在 history 记录上就够了：
 * withHistoryLock 只是进程内互斥，跨设备依然是整键读-改-写、后写者覆盖。
 * 赢家投完通知写 delivered:true，输家几乎同时在 releaseNotificationClaim 里
 * 撤掉自己的认领，两次写的是同一个 history 键，谁后落地不受控。输家的旧快照
 * 里赢家的记录还是 pending:true，于是 delivered:true 被覆盖回"认领中"。
 * 2 分钟后那条记录过期：既不算活跃竞争者（isActiveClaim 为假），也不算已投递
 * （delivered 标志已被抹掉），同一次变化就被当成"从未提醒过"再发一遍。
 *
 * 独立键只有赢家写，输家的撤回碰不到它，标记因此不会被回滚。
 * 写前重读并合并，是为了缩小两台设备"同时完成不同事件"时互相覆盖的窗口。
 */
async function markEventDelivered(eventKey) {
  if (!eventKey) return;
  await withHistoryLock(async () => {
    try {
      const map = { ...(await getDeliveredEvents()) };
      map[eventKey] = Date.now();
      const cutoff = Date.now() - HISTORY_READ_RETENTION_MS;
      const kept = Object.entries(map)
        .filter(([, at]) => Number(at) >= cutoff)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, DELIVERED_LIMIT);
      await chrome.storage.sync.set({ [DELIVERED_KEY]: Object.fromEntries(kept) });
    } catch (err) {
      // 标记只是跨设备去重的额外保险，写不进去绝不能让通知失败。
      console.error('[333 Watcher] delivered marker write failed:', err && err.message);
    }
  });
}

async function completeNotificationClaim(claimId, delivered, eventKey) {
  if (!claimId) return;
  await withHistoryLock(async () => {
    const history = await getHistory();
    const next = history.map(h => {
      if (!h || h.id !== claimId) return h;
      const updated = { ...h, pending: false };
      if (delivered) updated.delivered = true;
      else updated.failed = true;
      return updated;
    });
    if (!delivered) {
      // 发送失败时删除认领，让下一次检查可以重试。
      await saveHistory(next.filter(h => !h || h.id !== claimId));
    } else {
      await saveHistory(next);
    }
  });
  // 必须在锁外调用：markEventDelivered 自己也要拿这把锁，
  // 在锁内再等一次锁会死锁（withHistoryLock 是 promise 链，队列排在调用者后面）。
  // 发送失败时只删认领、不写标记，让下一次检查还能重试这条提醒。
  if (delivered) await markEventDelivered(eventKey);
}

// 输掉仲裁时撤回自己的认领，避免赢家被这条残留 pending 挡住。
async function releaseNotificationClaim(claimId) {
  if (!claimId) return;
  return withHistoryLock(async () => {
    const history = await getHistory();
    if (!history.some(h => h && h.id === claimId)) return;
    await saveHistory(history.filter(h => !h || h.id !== claimId));
  });
}

async function notifyOnce(event, record, notifId, title) {
  if (_pendingNotificationKeys.has(event.eventKey)) {
    return { ok: true, skipped: true, error: null };
  }
  _pendingNotificationKeys.add(event.eventKey);
  let claim;
  try {
    claim = await claimNotificationEvent(event, record);
    if (!claim.claimed) {
      return { ok: true, skipped: true, error: null };
    }
    const verdict = await arbitrateClaim(event, claim.claimId);
    if (verdict !== 'send') {
      await releaseNotificationClaim(claim.claimId);
      return { ok: true, skipped: true, error: null };
    }
    const result = await sendNotification(notifId, title, record.message);
    await completeNotificationClaim(claim.claimId, result.ok, event.eventKey);
    return result;
  } finally {
    _pendingNotificationKeys.delete(event.eventKey);
  }
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

  const event = buildNotificationEvent(monitor, 'change', message, {
    oldValue: change && change.oldValue,
    newValue: change && change.newValue,
    sequence: monitor.eventSeq
  });
  const result = await notifyOnce(event, {
    name: monitor.name || monitor.url,
    url: monitor.url,
    message: message,
    kind: 'change'
  }, notifId, title);
  if (!result.ok) console.error('[333 Watcher] 通知发送失败，error =', result.error);
  return result;
}

/**
 * 发送提醒，但绝不让异常冒泡到调用方。
 *
 * 基线此时已经落盘，检测流程已经算"做完"了；提醒写不进 history（配额/离线）
 * 或notifications.create 抛错时，若让异常一路冒泡出 checkMonitor，
 * 启动补检的 for 循环会当场中断，后面所有逾期监控都被静默跳过。
 * 基线已推进，下个周期本就不会重报这次变化——漏提醒无法自动补回，
 * 但跳过其余监控会造成大范围漏检，两害相权取轻，这里只记日志。
 */
async function safeNotify(kind, monitor, change) {
  try {
    if (kind === 'change') return await notifyChange(monitor, change);
    if (kind === 'recovered') return await notifyRecovered(monitor);
    if (kind === 'invalid') return await notifyInvalid(monitor, change);
  } catch (err) {
    console.error('[333 Watcher] notify failed (baseline already saved):', kind, monitor && monitor.id, err && err.message);
  }
  return { ok: false, skipped: true, error: null };
}

async function notifyInvalid(monitor, reason) {
  const name = monitor.name || monitor.url;
  const message = '"' + name + '" 监控失效：' + reason + '\n请检查网址是否有效，或重新拾取元素';
  const event = buildNotificationEvent(monitor, 'invalid', message, { reason: reason, sequence: monitor.eventSeq });
  return notifyOnce(event, {
    name: name, url: monitor.url, message: message, kind: 'invalid'
  }, 'notif-invalid-' + monitor.id, '333 Watcher · 监控失效');
}
async function notifyRecovered(monitor) {
  const name = monitor.name || monitor.url;
  const message = '"' + name + '" 已恢复正常 ✓';
  const event = buildNotificationEvent(monitor, 'recovered', message, { sequence: monitor.eventSeq });
  return notifyOnce(event, {
    name: name, url: monitor.url, message: message, kind: 'recovered'
  }, 'notif-recovered-' + monitor.id, '333 Watcher · 监控恢复');
}
async function markCheckFailure(monitorId, checkedAt, reason, kind) {
  let toNotify = null;
  try {
    const write = await mutateMonitors((list) => {
      const i = list.findIndex((m) => m.id === monitorId);
      if (i === -1) return false;
      const prev = list[i];
      const failCount = (Number(prev.failCount) || 0) + 1;
      const wasInvalid = !!prev.invalid;
      const nowTs = Date.now();
      const shouldInvalid = failCount >= INVALID_THRESHOLD;
      const eventSeq = shouldInvalid && !wasInvalid
        ? nextEventSequence(prev.eventSeq)
        : (Number(prev.eventSeq) || 0);
      list[i] = {
        ...prev,
        lastError: reason,
        failCount: failCount,
        lastCheck: checkedAt,
        lastCheckTime: nowTs,
        nextCheckTime: nowTs + Math.max(1, Number(prev.interval) || DEFAULT_INTERVAL) * 60000,
        invalid: wasInvalid || shouldInvalid,
        invalidReason: (wasInvalid || shouldInvalid) ? reason : (prev.invalidReason || ''),
        invalidSince: wasInvalid ? (prev.invalidSince || checkedAt) : (shouldInvalid ? checkedAt : (prev.invalidSince || null)),
        eventSeq
      };
      // 通知在锁外发送：notifyInvalid 会读监控、写 history，不能在临界区内嵌套。
      if (shouldInvalid && !wasInvalid) toNotify = { monitor: list[i], failCount };
      return true;
    });
    if (!write.saved) return kind === 'not-found' ? 'not-found' : 'error';
    if (toNotify) {
      await safeNotify('invalid', toNotify.monitor, reason + '（连续失败 ' + toNotify.failCount + ' 次）');
    }
  } catch (err) {
    // 失败计数写不进去时不能假装成功：log 出来，便于在扩展里排查同步配额/离线问题。
    console.error('[333 Watcher] markCheckFailure failed:', monitorId, err && err.message);
  }
  return kind === 'not-found' ? 'not-found' : 'error';
}
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith('notif-')) return;
  if (notifId.startsWith('notif-picked-') || notifId.startsWith('notif-test-')) {
    chrome.notifications.clear(notifId);
    return;
  }
  let monitorId = notifId.slice('notif-'.length);
  if (monitorId.startsWith('invalid-')) monitorId = monitorId.slice('invalid-'.length);
  if (monitorId.startsWith('recovered-')) monitorId = monitorId.slice('recovered-'.length);
  const monitors = await getMonitors();
  const monitor = monitors.find((m) => m.id === monitorId);
  if (monitor && !monitor.url.startsWith(TEST_URL_PREFIX)) {
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

  if (msg.type === 'test-get-status') {
    (async () => {
      const monitors = await getMonitors();
      const curText = await getTestTextValue();
      const curHref = await getTestHrefValue();
      const textMonitor = monitors.find((m) => m.url === TEST_URL_PREFIX + 'text') || monitors.find((m) => m.url === TEST_URL_PREFIX + 'demo' && m.attribute !== 'href') || null;
      const hrefMonitor = monitors.find((m) => m.url === TEST_URL_PREFIX + 'link') || monitors.find((m) => m.url === TEST_URL_PREFIX + 'demo' && m.attribute === 'href') || null;
      const testMonitor = textMonitor || hrefMonitor;
      sendResponse({ ok: true, cur: curText, curText, curHref, textMonitor, hrefMonitor, testMonitor });
    })();
    return true;
  }

  if (msg.type === 'test-simulate-change') {
    (async () => {
      const attr = msg.attribute === 'href' ? 'href' : 'text';
      if (attr === 'href') {
        const cur = await getTestHrefValue();
        let ver = 1;
        const mm = cur.match(/file-v([0-9]+).zip/i);
        if (mm) ver = parseInt(mm[1],10) + 1;
        else ver = Math.floor(Date.now()/1000)%100 + 2;
        const next = 'https://example.com/file-v' + ver + '.zip';
        await setTestHrefValue(next);
        sendResponse({ ok: true, attribute: attr, prev: cur, cur: next });
      } else {
        const cur = await getTestTextValue();
        const next = '模拟文本 ' + Date.now().toString().slice(-6) + ' (' + new Date().toLocaleTimeString() + ')';
        await setTestTextValue(next);
        sendResponse({ ok: true, attribute: attr, prev: cur, cur: next });
      }
    })();
    return true;
  }

  if (msg.type === 'test-create') {
    (async () => {
      const attr = msg.attribute === 'href' ? 'href' : 'text';
      const isHref = attr === 'href';
      const targetUrl = isHref ? TEST_URL_PREFIX + 'link' : TEST_URL_PREFIX + 'text';
      const legacyUrl = TEST_URL_PREFIX + 'demo';
      const cur = await getTestValue(attr);
      const monitor = {
        id: mintMonitorId(),
        name: isHref ? '🔍 测试监控-链接' : '📄 测试监控-文字',
        url: targetUrl,
        interval: 1,
        type: 'element',
        selector: isHref ? 'a#test-link' : '#test-value',
        attribute: attr,
        lastValue: limitMonitorValue(cur, attr),
        baselined: false,
        createdAt: new Date().toISOString(),
        updatedAt: Date.now(),
        lastHash: '',
        lastCheck: '',
        lastCheckTime: 0,
        nextCheckTime: 0,
        eventSeq: 0
      };
      // 去重判断与写入必须在同一临界区内，否则并发下会建出两条同目标测试监控。
      const write = await mutateMonitors((monitors) => {
        const existing = monitors.find((x) => x.url === targetUrl)
          || monitors.find((x) => x.url === legacyUrl && (x.attribute || 'text') === attr);
        if (existing) return { mode: 'exists', id: existing.id };
        monitors.push(monitor);
        return { mode: 'added', id: monitor.id };
      });
      if (write.result.mode === 'exists') {
        sendResponse({ ok: true, mode: 'exists', id: write.result.id, attribute: attr });
        return;
      }
      await chrome.alarms.create(ALARM_PREFIX + monitor.id, { delayInMinutes: 0.5, periodInMinutes: 1 });
      sendResponse({ ok: true, mode: 'added', id: monitor.id, attribute: attr });
    })();
    return true;
  }

  if (msg.type === 'test-clear') {
    (async () => {
      const write = await mutateMonitors((monitors) => {
        const isTest = (m) => m.url && m.url.startsWith(TEST_URL_PREFIX);
        const removedIds = monitors.filter(isTest).map((m) => m.id);
        monitors.splice(0, monitors.length, ...monitors.filter((m) => !isTest(m)));
        return removedIds;
      });
      await chrome.storage.sync.remove([TEST_STORAGE_KEY_TEXT, TEST_STORAGE_KEY_HREF, TEST_STORAGE_KEY_LEGACY]);
      for (const id of write.result) try { await chrome.alarms.clear(ALARM_PREFIX + id); } catch {}
      sendResponse({ ok: true, removed: write.result.length });
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

  // popup 的所有 monitors 写入都走这里：popup 与后台是两个 JS 上下文，进程内互斥锁
  // 互不生效，只有让 background 成为唯一写者才能真正避免整键覆盖丢数据。
  if (msg.type === 'mutate-monitors') {
    (async () => {
      try {
        const write = await mutateMonitors((list) => {
          if (msg.op === 'upsert') {
            const m = msg.monitor;
            if (!m || !m.id) return false;
            const idx = list.findIndex((x) => x.id === m.id);
            if (idx !== -1) {
              // id 是页面侧生成的，撞上另一条监控时不能直接覆盖 —— 那会把
              // 一条毫不相关的监控整条抹掉（连带它的 alarm 和基线）。
              // 目标不同就说明是撞车，重新发号并按新增处理。
              if (monitorKey(list[idx]) === monitorKey(m)) {
                list[idx] = m;
                return { id: m.id, mode: 'updated' };
              }
              const fresh = mintMonitorId();
              dbg('[333 Watcher] upsert id 撞车，重新发号:', m.id, '->', fresh);
              list.push({ ...m, id: fresh });
              return { id: fresh, mode: 'added' };
            }
            // 页面侧新增去重读的是旧快照，并发下仍可能撞上同 key 的既有监控：
            // 这里按 monitorKey 再兜一次底，命中就更新那条，而不是建出重复项。
            const sameKey = list.findIndex((x) => monitorKey(x) === monitorKey(m));
            if (sameKey !== -1) {
              const keptId = list[sameKey].id;
              list[sameKey] = { ...m, id: keptId };
              return { id: keptId, mode: 'updated' };
            }
            list.push(m);
            return { id: m.id, mode: 'added' };
          }
          if (msg.op === 'remove') {
            const before = list.length;
            list.splice(0, list.length, ...list.filter((x) => x.id !== msg.id));
            return { removed: before - list.length };
          }
          if (msg.op === 'set-interval') {
            const interval = clampInterval(msg.interval, DEFAULT_INTERVAL);
            list.forEach((x) => { x.interval = interval; });
            return { updated: list.length };
          }
          if (msg.op === 'import-by-key') {
            // 按 monitorKey 合并进“当前存储里的最新列表”，避免用页面旧快照整键覆盖。
            const map = new Map(list.map((x) => [monitorKey(x), x]));
            let added = 0;
            for (const m of (Array.isArray(msg.monitors) ? msg.monitors : [])) {
              if (!m) continue;
              const key = monitorKey(m);
              const prev = map.get(key);
              if (prev) {
                // 身份属于本机：id 是 alarm 名 / 通知 id / 检查锁的键，
                // 换成备份文件里的 id 会让在途的认领和已建的 alarm 对不上。
                map.set(key, { ...m, id: prev.id });
                continue;
              }
              added++;
              map.set(key, m);
            }
            // 备份文件里的 id 未必和本机不冲突：同一份备份可以在多台机器上
            // 与各自独立创建的监控撞 id。id 重复会让两条监控共用一个 alarm
            // （其中一条再也不会被检查）、共用同一个通知 id，且
            // findIndex(m.id === ...) 永远只命中第一条 —— 基线写到错的监控上。
            // 顺带修掉此前已被写坏的状态。
            const deduped = ensureUniqueMonitorIds([...map.values()]);
            list.splice(0, list.length, ...deduped);
            return { added: added, total: map.size };
          }
          return false;
        });
        if (!write.saved) {
          sendResponse({ ok: false, error: '未知的操作或参数无效' });
          return;
        }
        sendResponse({ ok: true, ...write.result });
      } catch (err) {
        console.error('[333 Watcher] mutate monitors failed:', err);
        sendResponse({ ok: false, error: err.message, code: err.code || 'STORAGE_ERROR' });
      }
    })();
    return true;
  }

  // 标记已读同样走 background：让 history 的所有写操作共用一把进程内互斥锁，
  // 避免 popup 的整键读-改-写覆盖掉后台刚写入的事件认领。
  if (msg.type === 'mark-history-read' || msg.type === 'mark-all-history-read') {
    (async () => {
      try {
        const result = await withHistoryLock(async () => {
          const history = await getHistory();
          if (msg.type === 'mark-history-read') {
            const item = history.find((h) => h && h.id === msg.id);
            // 未完成投递的认领不是提醒，既不展示也不应被标记已读。
            if (!item || item.read || item.pending) return { updated: 0 };
            item.read = true;
            item.readAt = Date.now();
            await saveHistory(history);
            return { updated: 1 };
          }
          // 不触碰尚未完成投递的事件认领，避免影响跨设备去重判断。
          let updated = 0;
          const next = history.map((h) => {
            if (!h || typeof h !== 'object' || h.pending || h.read) return h;
            updated++;
            return { ...h, read: true, readAt: Date.now() };
          });
          if (updated > 0) await saveHistory(next);
          return { updated };
        });
        await updateBadge();
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error('[333 Watcher] mark history read failed:', err);
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
    try {
      await checkMonitor(monitor);
    } catch (err) {
      // 监听器里的未捕获 rejection 只会变成一条无上下文的日志，这里补上 id。
      console.error('[333 Watcher] alarm check failed:', monitorId, err && err.message);
    }
  }
});

  dbg('[333 Watcher] Background service worker loaded (v0.6.39)');



// ================= 通知历史 + 角标（chrome.storage.sync，跨设备同步） =================
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 50; // storage.sync 容量有限，只保留最近 50 条
const HISTORY_MAX_BYTES = 7000; // storage.sync 单 key 上限 8KB，留出余量
const HISTORY_READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 已读通知保留 7 天后自动清理
// 已投递事件的独立标记，单独占一个 storage.sync 键。
// 见下方 markEventDelivered 的说明：不能只依赖 history 记录上的 delivered 字段。
const DELIVERED_KEY = 'deliveredEvents';
const DELIVERED_LIMIT = 60;

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

// history 是整键读-改-写，跨设备并发时后写者会覆盖先写者。
// 所有写入统一走这把进程内互斥锁，配合下面的确定性仲裁，把并发写入串行化。
let _historyLock = Promise.resolve();
function withHistoryLock(fn) {
  const run = _historyLock.then(() => fn(), () => fn());
  _historyLock = run.then(() => {}, () => {});
  return run;
}

// 清理已读通知：超过保留期后自动删除，避免历史无限累积
async function pruneHistory() {
  return withHistoryLock(async () => {
    try {
      const history = await getHistory();
      if (!history.length) return;
      const cutoff = Date.now() - HISTORY_READ_RETENTION_MS;
      const kept = history.filter((h) => {
        // 崩溃或进程被杀留下的未完成认领，不再具备抑制作用，直接丢弃。
        if (h && h.pending && !isActiveClaim(h)) return false;
        if (!h || typeof h !== 'object') return false;
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
  });
}

async function clearReadHistory() {
  return withHistoryLock(async () => {
    try {
      const history = await getHistory();
      if (!history.length) return { removed: 0, kept: 0 };
      const kept = history.filter((h) => h && typeof h === 'object' && !h.read);
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
  });
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
  // 未完成的跨设备认领尚未确认投递，不计入未读数。
  // 注意：`h && !h.pending` 才会剔除 null 记录；写成 `!h || !h.pending` 会把 null 留下，
  // 随后的 h.read 就会抛 TypeError。
  const history = (await getHistory()).filter((h) => h && !h.pending);
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
      // 逐个隔离：单个监控抛错（网络异常、存储配额、通知链路）不得让其余
      // 逾期监控在本次开机补检中被静默跳过。
      try {
        await checkMonitor(m);
      } catch (err) {
        console.error('[333 Watcher] catch-up check failed:', m.id, err && err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await catchUpChecks();
});






