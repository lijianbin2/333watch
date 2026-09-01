/**
 * 333 Watcher - Add Monitor 页面逻辑 (v0.6.1)
 *
 * 监控类型：
 * - page：整个网页变化（整页 hash）
 * - element：指定内容变化（CSS selector + 属性 text/href/src）
 *
 * 兼容：
 * - 旧 type="link" 由 background 迁移为 type="element" + attribute="href"
 */

const form = document.getElementById('monitor-form');
const inputType = document.getElementById('input-type');
const inputAttribute = document.getElementById('input-attribute');
const inputName = document.getElementById('input-name');
const inputUrl = document.getElementById('input-url');
const inputInterval = document.getElementById('input-interval');
const submitBtn = document.getElementById('submit-btn');
const statusMsg = document.getElementById('status-msg');
const listEl = document.getElementById('monitor-list');
const countEl = document.getElementById('monitor-count');
const syncBadge = document.getElementById('sync-badge');
const unreadBadge = document.getElementById('unread-badge');

const editingBanner = document.getElementById('editing-banner');
const cancelEditBtn = document.getElementById('cancel-edit-btn');
const overwriteConfirm = document.getElementById('overwrite-confirm');
const confirmOverwriteBtn = document.getElementById('confirm-overwrite-btn');
const cancelOverwriteBtn = document.getElementById('cancel-overwrite-btn');

const elementSection = document.getElementById('element-section');
const pickElementBtn = document.getElementById('pick-element-btn');
const pickedInfo = document.getElementById('picked-info');

const notifyCard = document.getElementById('notify-card');
const notifyDot = document.getElementById('notify-dot');
const notifySummary = document.getElementById('notify-summary');
const markAllReadBtn = document.getElementById('mark-all-read-btn');
const clearReadBtn = document.getElementById('clear-read-btn');
const historyToggle = document.getElementById('history-toggle');
const historyList = document.getElementById('history-list');
const historyArrow = document.getElementById('history-arrow');
const bulkIntervalBtn = document.getElementById('bulk-interval-btn');

const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
const hasTabsApi = typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query;
const hasScripting = typeof chrome !== 'undefined' && chrome.scripting && chrome.scripting.executeScript;
const DEFAULT_INTERVAL = 500;

// ---- 状态 ----
let editingId = null;
let pickedElement = null;   // { selector, attribute, text, href, pageUrl, pageTitle, tagName }
let historyExpanded = false;

const DEBUG = false; // 发布版关闭信息日志，调试时改为 true
function dbg(...args) { if (DEBUG) console.log(...args); }

const ALARM_PREFIX = 'monitor-'; // 与 background.js 保持一致，删除监控时清理 alarm

// ---- 同步状态显示 ----
function renderSyncBadge() {
  if (hasChromeStorage) {
    syncBadge.textContent = 'Chrome 同步：已启用';
    syncBadge.classList.remove('offline');
  } else {
    syncBadge.textContent = '本地预览模式';
    syncBadge.classList.add('offline');
  }
}

// ---- URL 规范化 ----
function normalizeUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

// ---- 监控存储层（chrome.storage.sync） ----
async function getMonitors() {
  if (hasChromeStorage) {
    const { monitors = [] } = await chrome.storage.sync.get('monitors');
    return monitors;
  }
  try {
    return JSON.parse(localStorage.getItem('monitors') || '[]');
  } catch {
    return [];
  }
}

async function saveMonitors(monitors) {
  if (hasChromeStorage) {
    await chrome.storage.sync.set({ monitors });
  } else {
    localStorage.setItem('monitors', JSON.stringify(monitors));
  }
}

// ---- 通知历史存储层（chrome.storage.sync，跨设备同步） ----
const HISTORY_LIMIT = 50;
const HISTORY_MAX_BYTES = 7000; // storage.sync 单 key 上限 8KB，留出余量

function utf8Bytes(str) {
  return new TextEncoder().encode(str).length;
}

async function getHistory() {
  if (hasChromeStorage) {
    const { history = [] } = await chrome.storage.sync.get('history');
    return Array.isArray(history) ? history : [];
  }
  try {
    return JSON.parse(localStorage.getItem('history') || '[]');
  } catch {
    return [];
  }
}

async function saveHistory(history) {
  let list = Array.isArray(history) ? history : [];
  list = list.slice(0, HISTORY_LIMIT);
  if (hasChromeStorage) {
    // 超长时优先丢弃最旧记录，避免写入超过 storage.sync 的 8KB 单 key 限制
    while (list.length > 1 && utf8Bytes(JSON.stringify(list)) > HISTORY_MAX_BYTES) {
      list = list.slice(0, -1);
    }
    await chrome.storage.sync.set({ history: list });
  } else {
    localStorage.setItem('history', JSON.stringify(list));
  }
}

// 清理已读通知：超过保留期后自动删除，避免历史无限累积
const HISTORY_READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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
    }
  } catch (err) {
    console.error('[333 Watcher] history prune failed:', err);
  }
}

// ---- 未读数显示 ----
async function renderUnread() {
  await pruneHistory();
  const history = await getHistory();
  const unread = history.filter((h) => !h.read).length;

  unreadBadge.textContent = unread;
  unreadBadge.classList.toggle('hidden', unread === 0);
  unreadBadge.title = unread > 0 ? unread + ' 条未读提醒' : '';

  notifyDot.classList.toggle('hidden', unread === 0);
  notifyCard.classList.toggle('has-unread', unread > 0);
  markAllReadBtn.classList.toggle('hidden', unread === 0);
  const hasRead = history.some((h) => h.read);
  if (clearReadBtn) clearReadBtn.classList.toggle('hidden', !hasRead);
  if (unread > 0) {
    notifySummary.textContent = unread + ' 条未读';
  } else if (history.length > 0) {
    notifySummary.textContent = '共 ' + history.length + ' 条，全部已读';
  } else {
    notifySummary.textContent = '暂无通知';
  }
}

// ---- 通知历史展开 ----
historyToggle.addEventListener('click', async () => {
  historyExpanded = !historyExpanded;
  historyList.classList.toggle('hidden', !historyExpanded);
  historyArrow.textContent = historyExpanded ? '▾' : '▸';
  if (historyExpanded) {
    await renderHistoryList();
  }
});

markAllReadBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  await markAllHistoryRead();
  if (historyExpanded) await renderHistoryList();
});

if (clearReadBtn) {
  clearReadBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const history = await getHistory();
    const readCount = history.filter((h) => h.read).length;
    if (readCount === 0) return;
    const ok = confirm('确定清除 ' + readCount + ' 条已读记录吗？未读记录将保留。');
    if (!ok) return;
    await clearReadHistory();
  });
}

async function markHistoryItemRead(id) {
  const history = await getHistory();
  const item = history.find((h) => h.id === id);
  if (!item || item.read) return;
  item.read = true;
  item.readAt = Date.now();
  await saveHistory(history);
  renderUnread();
}

async function markAllHistoryRead() {
  const history = await getHistory();
  if (!history.some((h) => !h.read)) return;
  await saveHistory(history.map((h) => ({ ...h, read: true, readAt: Date.now() })));
  renderUnread();
}

async function clearReadHistory() {
  try {
    if (hasChromeStorage && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'clear-read-history' });
        if (res && res.ok) {
          renderUnread();
          if (historyExpanded) await renderHistoryList();
          return;
        }
      } catch (e) {
        // fallback to direct storage
      }
    }
    const history = await getHistory();
    const kept = history.filter((h) => !h.read);
    if (kept.length === history.length) return;
    await saveHistory(kept);
    renderUnread();
    if (historyExpanded) await renderHistoryList();
  } catch (err) {
    console.error('[333 Watcher] clear read history failed:', err);
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function renderHistoryList() {
  const history = await getHistory();
  historyList.innerHTML = '';

  if (history.length === 0) {
    const li = document.createElement('li');
    li.className = 'history-empty';
    li.textContent = '暂无通知记录';
    historyList.appendChild(li);
    return;
  }

  for (const h of history.slice(0, 20)) {
    const li = document.createElement('li');
    li.className = 'history-item' + (h.read ? '' : ' unread');

    const msg = document.createElement('p');
    msg.className = 'history-msg';
    msg.textContent = h.message || h.name || '页面发生变化';
    li.appendChild(msg);

    const time = document.createElement('p');
    time.className = 'history-time';
    time.textContent = formatTime(h.time);
    li.appendChild(time);

    li.classList.add('clickable');
    li.title = h.url ? '点击打开 ' + h.url : '点击标记已读';
    li.addEventListener('click', async () => {
      await markHistoryItemRead(h.id);
      if (h.url) openUrl(h.url);
    });
    historyList.appendChild(li);
  }
}

// ---- 打开网址 ----
function openUrl(url) {
  if (!url) return;
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url: url });
  } else {
    window.open(url, '_blank');
  }
}

async function closePagePicker() {
  if (!hasTabsApi) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'w333-close-dialog' });
    }
  } catch {}
}

// ---- 页脚版本号 ----
(function renderFooterVersion() {
  const el = document.getElementById('footer-version');
  if (!el) return;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
    el.textContent = '333 Watcher v' + chrome.runtime.getManifest().version;
  }
})();

// ---- 页脚 GitHub 链接 ----
document.getElementById('about-link').addEventListener('click', (e) => {
  e.preventDefault();
  openUrl('https://github.com/lijianbin2/333watch');
});

// ---- 类型切换 ----
function syncTypeSections() {
  const t = inputType.value;
  elementSection.classList.toggle('hidden', t !== 'element');
  if (t !== 'element') {
    // 切到“整个网页”时，清理残留的点选状态并关闭网页上的选择浮层，避免误进选元素模式
    pickedElement = null;
    hidePickedInfo();
    // 异步清理，不阻塞切换
    clearPendingPick();
    closePagePicker();
  }
}

inputType.addEventListener('change', syncTypeSections);

// 属性标签
function attributeLabel(attr) {
  if (attr === 'href') return '链接地址';
  if (attr === 'src') return '图片地址';
  return '文本内容';
}

// ---- 元素点选 ----
pickElementBtn.addEventListener('click', async () => {
  if (inputType.value !== 'element') {
    showStatus('请先将监控类型切换为“指定内容变化”再选择元素', true);
    return;
  }
  if (!hasTabsApi || !hasScripting) {
    showStatus('本地预览模式不支持元素选择', true);
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) {
      showStatus('请在普通网页（http/https）上使用元素选择', true);
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['picker.js']
    });
    showStatus('已注入选择器，请回到网页移动鼠标高亮元素', false);
    setTimeout(() => window.close(), 800);
  } catch (err) {
    console.error('[333 Watcher] picker inject failed:', err);
    showStatus('注入失败：' + err.message, true);
  }
});

function showPickedInfo(pick, prefix) {
  const label = attributeLabel(pick.attribute);
  const sample = pick.attribute === 'href' ? (pick.href || '') : (pick.text || '');
  pickedInfo.textContent = (prefix || '已选择：') + (pick.tagName || '元素') + ' · ' + label +
    (sample ? ' · ' + sample.slice(0, 40) : '');
  pickedInfo.title = pick.selector || '';
  pickedInfo.classList.remove('hidden');
}

function hidePickedInfo() {
  pickedInfo.classList.add('hidden');
  pickedInfo.textContent = '';
}

async function clearPendingPick() {
  pickedElement = null;
  hidePickedInfo();
  if (hasChromeStorage) {
    try { await chrome.storage.sync.remove('pendingPick'); } catch {}
  }
}

async function loadPendingPick() {
  if (!hasChromeStorage || editingId !== null) return false;
  try {
    const { pendingPick } = await chrome.storage.sync.get('pendingPick');
    if (!pendingPick || !pendingPick.selector) return false;
    pickedElement = pendingPick;
    inputType.value = 'element';
    inputAttribute.value = pendingPick.attribute || 'text';
    inputUrl.value = pendingPick.pageUrl || '';
    inputName.value = pendingPick.pageTitle || pendingPick.text || '';
    syncTypeSections();
    showPickedInfo(pendingPick);
    dbg('[333 Watcher] pendingPick loaded:', pendingPick.selector);
    return true;
  } catch (err) {
    console.error('[333 Watcher] load pendingPick failed:', err);
    return false;
  }
}

inputAttribute.addEventListener('change', () => {
  if (pickedElement) {
    pickedElement.attribute = inputAttribute.value;
    showPickedInfo(pickedElement);
  }
});

// ---- 编辑态切换 ----
function enterEditMode(monitor) {
  editingId = monitor.id;
  inputType.value = monitor.type || 'page';
  inputAttribute.value = monitor.attribute || 'text';
  inputName.value = monitor.name || '';
  inputUrl.value = monitor.url || '';
  inputInterval.value = monitor.interval || DEFAULT_INTERVAL;

  syncTypeSections();
  hidePickedInfo();
  pickedElement = null;

  if (monitor.type === 'element' && monitor.selector) {
    showPickedInfo({
      tagName: '元素',
      attribute: monitor.attribute || 'text',
      text: monitor.selector,
      href: monitor.targetHref || '',
      selector: monitor.selector
    }, '当前元素：');
  }

  submitBtn.textContent = '保存修改';
  editingBanner.classList.remove('hidden');
  hideStatus();
  hideOverwriteConfirm();
  inputName.focus();
}

function exitEditMode() {
  editingId = null;
  form.reset();
  inputType.value = 'page';
  inputAttribute.value = 'text';
  inputInterval.value = DEFAULT_INTERVAL;
  syncTypeSections();
  hidePickedInfo();
  pickedElement = null;
  submitBtn.textContent = '保存监控';
  editingBanner.classList.add('hidden');
  hideOverwriteConfirm();
}

cancelEditBtn.addEventListener('click', exitEditMode);

// ---- 自动填充当前标签页信息（仅新增模式，且无点选结果时） ----
async function fillFromActiveTab() {
  if (!hasTabsApi || editingId !== null) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (tab.url && /^https?:/.test(tab.url)) {
      inputUrl.value = tab.url;
    }
    if (tab.title) {
      inputName.value = tab.title;
    }
  } catch (err) {
    console.error('[333 Watcher] Failed to read active tab:', err);
  }
}

// ---- 表单数据收集 ----
function collectFormData() {
  return {
    type: inputType.value,
    name: inputName.value.trim(),
    url: normalizeUrl(inputUrl.value),
    interval: Math.max(1, parseInt(inputInterval.value, 10) || DEFAULT_INTERVAL)
  };
}

// ---- 保存监控 ----
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideStatus();

  const data = collectFormData();
  const monitors = await getMonitors();

  if (data.type === 'element' && !pickedElement && editingId === null) {
    showStatus('请先点击「选择网页元素」在页面上点选目标', true);
    return;
  }

  // 编辑模式：直接覆盖旧数据
  if (editingId !== null) {
    const idx = monitors.findIndex((m) => m.id === editingId);
    if (idx === -1) {
      showStatus('该监控已被删除', true);
      exitEditMode();
      return;
    }
    const old = monitors[idx];
    const updated = {
      ...old,
      name: data.name,
      url: data.url,
      interval: data.interval,
      type: data.type
    };
    if (data.type === 'element') {
      if (pickedElement) {
        updated.selector = pickedElement.selector;
        updated.attribute = inputAttribute.value;
        updated.lastValue = attributeValue(pickedElement, updated.attribute);
      } else {
        updated.attribute = inputAttribute.value; // 保留旧 selector，只改属性也可
        updated.lastValue = '';
      }
      updated.lastHash = '';
    } else {
      // page 类型：清掉 element 字段；URL 变了重置 hash 基线
      updated.selector = '';
      updated.attribute = '';
      updated.lastValue = '';
      updated.lastHash = normalizeUrl(old.url) === data.url && old.type === 'page' ? old.lastHash : '';
    }
    updated.targetHref = '';
    updated.targetText = '';
    monitors[idx] = updated;
    await saveMonitors(monitors);
    await closePagePicker();
    dbg('[333 Watcher] Monitor updated:', updated);
    exitEditMode();
    await clearPendingPick();
    showStatus('修改已保存 ✓', false);
    renderList();
    return;
  }

  // 新增模式：重复检测（同一网址只允许一个监控，避免重复通知）
  const existing = monitors.find((m) => normalizeUrl(m.url || '') === data.url);
  if (existing) {
    showOverwriteConfirm(existing, data);
    return;
  }

  await addMonitor(data);
});

function attributeValue(pick, attr) {
  if (attr === 'href') return pick.href || '';
  if (attr === 'src') return pick.src || '';
  return pick.text || '';
}

// ---- 新增 ----
async function addMonitor(data) {
  const monitors = await getMonitors();
  const attribute = data.type === 'element' ? inputAttribute.value : '';
  const monitor = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: data.name,
    url: data.url,
    interval: data.interval,
    type: data.type,
    selector: data.type === 'element' ? pickedElement.selector : '',
    attribute: data.type === 'element' ? attribute : '',
    lastValue: data.type === 'element' ? attributeValue(pickedElement, attribute) : '',
    createdAt: new Date().toISOString(),
    updatedAt: Date.now(),
    lastHash: '',
    lastCheck: '',
    lastCheckTime: 0,
    nextCheckTime: 0
  };
  monitors.push(monitor);
  await saveMonitors(monitors);
  await closePagePicker();
  dbg('[333 Watcher] Monitor added:', monitor);
  await clearPendingPick();
  showStatus('已保存 ✓', false);
  form.reset();
  inputType.value = 'page';
  inputAttribute.value = 'text';
  inputInterval.value = DEFAULT_INTERVAL;
  syncTypeSections();
  renderList();

  if (hasChromeStorage) {
    setTimeout(() => window.close(), 400);
  }
}

// ---- 覆盖确认 ----
let pendingOverwrite = null;

function showOverwriteConfirm(existing, data) {
  pendingOverwrite = { existing, data };
  overwriteConfirm.classList.remove('hidden');
  hideStatus();
}

function hideOverwriteConfirm() {
  pendingOverwrite = null;
  overwriteConfirm.classList.add('hidden');
}

confirmOverwriteBtn.addEventListener('click', async () => {
  if (!pendingOverwrite) return;
  const { existing, data } = pendingOverwrite;
  hideOverwriteConfirm();

  const monitors = await getMonitors();
  const idx = monitors.findIndex((m) => m.id === existing.id);
  if (idx !== -1) {
    const old = monitors[idx];
    const updated = {
      ...old,
      name: data.name,
      url: data.url,
      interval: data.interval,
      type: data.type
    };
    if (data.type === 'element' && pickedElement) {
      updated.selector = pickedElement.selector;
      updated.attribute = inputAttribute.value;
      updated.lastValue = attributeValue(pickedElement, updated.attribute);
    } else if (data.type === 'page') {
      updated.selector = '';
      updated.attribute = '';
      updated.lastValue = '';
      updated.lastHash = normalizeUrl(old.url) === data.url ? old.lastHash : '';
    }
    updated.targetHref = '';
    updated.targetText = '';
    updated.lastHash = '';
    monitors[idx] = updated;
    await saveMonitors(monitors);
    await closePagePicker();
    dbg('[333 Watcher] Monitor overwritten:', updated);
  }
  await clearPendingPick();
  showStatus('已覆盖保存 ✓', false);
  form.reset();
  inputType.value = 'page';
  inputAttribute.value = 'text';
  inputInterval.value = DEFAULT_INTERVAL;
  syncTypeSections();
  renderList();

  if (hasChromeStorage) {
    setTimeout(() => window.close(), 400);
  }
});

cancelOverwriteBtn.addEventListener('click', () => {
  hideOverwriteConfirm();
  showStatus('已取消保存', true);
});

// ---- 监控列表渲染 ----
function typeLabel(m) {
  if (m.type === 'element') return '指定内容';
  return '整个网页';
}

function monitorUpdatedAt(m) {
  if (typeof m.updatedAt === 'number') return m.updatedAt;
  if (typeof m.createdAt === 'string') {
    const t = new Date(m.createdAt).getTime();
    if (!isNaN(t)) return t;
  }
  return 0;
}

async function renderList() {
  const monitors = (await getMonitors()).slice().sort((a, b) => monitorUpdatedAt(b) - monitorUpdatedAt(a));
  countEl.textContent = monitors.length;

  listEl.innerHTML = '';
  for (const m of monitors) {
    const li = document.createElement('li');
    li.className = 'watcher-item';

    const info = document.createElement('div');
    info.className = 'watcher-info';

    const name = document.createElement('a');
    name.className = 'watcher-url watcher-link';
    name.textContent = m.name || m.url;
    name.href = m.url || '#';
    name.title = (m.url || '') + '（点击打开）';
    name.addEventListener('click', (e) => {
      e.preventDefault();
      openUrl(m.url);
    });
    info.appendChild(name);

    const meta = document.createElement('p');
    meta.className = 'watcher-meta';
    let metaText = typeLabel(m) + ' · 每 ' + m.interval + ' 分钟';
    if (m.type === 'element' && m.attribute) {
      metaText += ' · ' + attributeLabel(m.attribute);
    }
    if (m.type === 'element' && m.selector) {
      metaText += ' · ' + m.selector;
    }
    meta.textContent = metaText;
    meta.title = m.selector || '';
    info.appendChild(meta);

    if (m.lastError) {
      const errEl = document.createElement('p');
      errEl.className = 'watcher-error';
      errEl.textContent = '⚠ 上次检查失败：' + m.lastError;
      errEl.title = m.lastError;
      info.appendChild(errEl);
    } else if (m.lastCheck) {
      const timeEl = document.createElement('p');
      timeEl.className = 'watcher-time';
      const d = new Date(m.lastCheck);
      timeEl.textContent = '上次检查：' + d.toLocaleString() + (m.nextCheckTime ? ' · 下次：' + new Date(m.nextCheckTime).toLocaleString() : '');
      info.appendChild(timeEl);
    }

    const feedback = document.createElement('p');
    feedback.className = 'watcher-feedback hidden';
    info.appendChild(feedback);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const check = document.createElement('button');
    check.className = 'btn-check';
    check.type = 'button';
    check.textContent = '立即检查';
    check.title = '立即执行一次检查';
    check.addEventListener('click', () => checkNow(m.id, check, feedback));

    const edit = document.createElement('button');
    edit.className = 'btn-check';
    edit.type = 'button';
    edit.textContent = '编辑';
    edit.title = '编辑该监控';
    edit.addEventListener('click', () => enterEditMode(m));

    const del = document.createElement('button');
    del.className = 'btn-delete';
    del.type = 'button';
    del.textContent = '×';
    del.title = '删除';
    del.addEventListener('click', () => removeMonitor(m.id));

    actions.appendChild(check);
    actions.appendChild(edit);
    actions.appendChild(del);
    li.appendChild(info);
    li.appendChild(actions);
    listEl.appendChild(li);
  }
}

// ---- 立即检查 ----
async function checkNow(id, btn, feedback) {
  btn.disabled = true;
  btn.textContent = '...';
  hideStatus();
  showCheckFeedback(feedback, '正在检查...', false);
  try {
    if (!(hasChromeStorage && chrome.runtime && chrome.runtime.sendMessage)) {
      showCheckFeedback(feedback, '本地预览模式不支持检查', true);
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: 'check-now', id: id });
    if (!res || !res.ok) {
      showCheckFeedback(feedback, '检查失败：' + ((res && res.error) || '未知错误') + '，请查看 Service Worker 日志', true);
    } else if (res.result === 'changed') {
      showCheckFeedback(feedback, '检测到变化，已发送通知 ✓', false);
      renderUnread();
      renderList();
    } else if (res.result === 'not-found') {
      showCheckFeedback(feedback, '未找到目标元素，页面结构可能已变化（已尝试自愈）', true);
    } else if (res.result === 'error') {
      showCheckFeedback(feedback, '网络请求失败，请检查网址或网络', true);
      renderList();
    } else if (res.result === 'flaky') {
      showCheckFeedback(feedback, '检测到抖动，已抑制通知（下次再确认）', false);
    } else {
      showCheckFeedback(feedback, '暂无变化', false);
      renderList();
    }
  } catch (err) {
    console.error('[333 Watcher] check-now failed:', err);
    showCheckFeedback(feedback, '检查失败，详见 Service Worker 日志', true);
  } finally {
    btn.disabled = false;
    btn.textContent = '立即检查';
  }
}

function showCheckFeedback(element, text, isError) {
  if (!element) return;
  listEl.querySelectorAll('.watcher-feedback').forEach((item) => {
    item.classList.add('hidden');
    item.classList.remove('error');
  });
  element.textContent = text;
  element.classList.remove('hidden');
  element.classList.toggle('error', !!isError);
}

// ---- 批量更新已有监控的检查间隔 ----
bulkIntervalBtn.addEventListener('click', async () => {
  const monitors = await getMonitors();
  if (!monitors.length) {
    showStatus('还没有可更新的监控', true);
    return;
  }
  const confirmed = window.confirm('确定把全部 ' + monitors.length + ' 个监控的检查间隔改为 500 分钟吗？');
  if (!confirmed) return;

  const updated = monitors.map((m) => ({ ...m, interval: DEFAULT_INTERVAL }));
  await saveMonitors(updated);
  renderList();
  showStatus('已将 ' + updated.length + ' 个监控的检查间隔改为 500 分钟 ✓', false);
});

// ---- 测试通知 ----
const testNotifyBtn = document.getElementById('test-notify-btn');
testNotifyBtn.addEventListener('click', async () => {
  testNotifyBtn.disabled = true;
  hideStatus();
  try {
    if (!(hasChromeStorage && chrome.runtime && chrome.runtime.sendMessage)) {
      showStatus('本地预览模式不支持通知', true);
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: 'test-notification' });
    if (res && res.ok) {
      showStatus('测试通知已发送（ID: ' + res.notificationId + '），若未弹出请检查系统通知设置', false);
    } else {
      showStatus('通知发送失败：' + ((res && res.error) || '未知错误') + '（可能通知权限不足）', true);
    }
  } catch (err) {
    console.error('[333 Watcher] test notification failed:', err);
    showStatus('通知发送失败：' + err.message, true);
  } finally {
    testNotifyBtn.disabled = false;
  }
});

async function removeMonitor(id) {
  const monitors = await getMonitors();
  const target = monitors.find((m) => m.id === id);
  const url = target ? normalizeUrl(target.url || '') : '';
  // 同一网址的所有监控一起删除，避免残留监控继续发通知
  if (url) {
    const sameUrl = monitors.filter((m) => normalizeUrl(m.url || '') === url);
    if (sameUrl.length > 1) {
      const ok = window.confirm('该网址有 ' + sameUrl.length + ' 个监控，将一并删除，是否继续？');
      if (!ok) return;
    }
  }
  const kept = url
    ? monitors.filter((m) => normalizeUrl(m.url || '') !== url)
    : monitors.filter((m) => m.id !== id);
  await saveMonitors(kept);
  // 立即清除对应 alarm，防止删除后仍被调度检查
  if (typeof chrome !== 'undefined' && chrome.alarms) {
    const removed = monitors.filter((m) => !kept.includes(m));
    for (const m of removed) {
      try { await chrome.alarms.clear(ALARM_PREFIX + m.id); } catch {}
    }
  }
  if (editingId === id) exitEditMode();
  renderList();
}

function showStatus(text, isError) {
  statusMsg.textContent = text;
  statusMsg.classList.remove('hidden');
  statusMsg.classList.toggle('error', !!isError);
}

function hideStatus() {
  statusMsg.classList.add('hidden');
  statusMsg.classList.remove('error');
}

// ---- 历史变化时实时刷新未读徽标 ----
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.history) {
      renderUnread();
    }
  });
}

// ---- 数据迁移：导出 / 导入（本地版 ↔ 商店版） ----
const exportBtn = document.getElementById('export-btn');
const importToggleBtn = document.getElementById('import-toggle-btn');
const importBox = document.getElementById('import-box');
const importArea = document.getElementById('import-area');
const importConfirmBtn = document.getElementById('import-confirm-btn');
const migrateStatus = document.getElementById('migrate-status');

function showMigrateStatus(text, isError) {
  migrateStatus.textContent = text;
  migrateStatus.classList.remove('hidden');
  migrateStatus.classList.toggle('error', !!isError);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

exportBtn.addEventListener('click', async () => {
  try {
    const monitors = await getMonitors();
    const payload = JSON.stringify({
      app: '333-watcher',
      exportedAt: new Date().toISOString(),
      monitors: monitors
    }, null, 2);
    const ok = await copyText(payload);
    if (ok) {
      showMigrateStatus('已复制导出内容，请到另一个版本点击「导入设置」粘贴后导入');
    } else {
      console.log('[333 Watcher] 导出数据:', payload);
      showMigrateStatus('复制失败，请从控制台复制导出的 JSON', true);
    }
  } catch (err) {
    showMigrateStatus('导出失败：' + err.message, true);
  }
});

importToggleBtn.addEventListener('click', () => {
  const willShow = importBox.classList.contains('hidden');
  importBox.classList.toggle('hidden', !willShow);
  if (willShow) importArea.focus();
});

importConfirmBtn.addEventListener('click', async () => {
  try {
    const data = JSON.parse(importArea.value.trim());
    if (!data || !Array.isArray(data.monitors)) {
      throw new Error('格式不正确，请粘贴完整的导出内容');
    }
    const imported = data.monitors;
    const current = await getMonitors();
    const map = new Map(current.map((m) => [normalizeUrl(m.url || ''), m]));
    let added = 0;
    for (const m of imported) {
      const key = normalizeUrl(m.url || '');
      if (!key) continue;
      if (!map.has(key)) added++;
      map.set(key, m);
    }
    await saveMonitors([...map.values()]);
    renderList();
    showMigrateStatus('导入成功：共 ' + imported.length + ' 条，新增 ' + added + ' 条');
  } catch (err) {
    showMigrateStatus('导入失败：' + err.message, true);
  }
});

// ---- 初始化 ----
(async function init() {
  renderSyncBadge();
  renderUnread();
  renderList();
  const hasPick = await loadPendingPick();
  if (!hasPick) {
    fillFromActiveTab();
  }
  syncTypeSections();
})();




