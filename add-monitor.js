/**
 * 333 Watcher - Add Monitor 页面逻辑 (v0.5.2)
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
const historyToggle = document.getElementById('history-toggle');
const historyList = document.getElementById('history-list');
const historyArrow = document.getElementById('history-arrow');

const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
const hasLocalStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const hasTabsApi = typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query;
const hasScripting = typeof chrome !== 'undefined' && chrome.scripting && chrome.scripting.executeScript;

// ---- 状态 ----
let editingId = null;
let pickedElement = null;   // { selector, attribute, text, href, pageUrl, pageTitle, tagName }
let historyExpanded = false;

const DEBUG = false; // 发布版关闭信息日志，调试时改为 true
function dbg(...args) { if (DEBUG) console.log(...args); }

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

// ---- 通知历史存储层（chrome.storage.local） ----
async function getHistory() {
  if (hasLocalStorage) {
    const { history = [] } = await chrome.storage.local.get('history');
    return Array.isArray(history) ? history : [];
  }
  try {
    return JSON.parse(localStorage.getItem('history') || '[]');
  } catch {
    return [];
  }
}

async function saveHistory(history) {
  if (hasLocalStorage) {
    await chrome.storage.local.set({ history });
  } else {
    localStorage.setItem('history', JSON.stringify(history));
  }
}

// 清理已读通知：超过保留期后自动删除，避免历史无限累积
const HISTORY_READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
async function pruneHistory() {
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
    window.close();
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
  inputInterval.value = monitor.interval || 1000;

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
  inputInterval.value = 1000;
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
    interval: Math.max(1, parseInt(inputInterval.value, 10) || 1000)
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

  // 新增模式：重复检测
  // page: 同 URL；element: 同 URL + 同 selector
  const existing = monitors.find((m) => {
    if (normalizeUrl(m.url || '') !== data.url) return false;
    if ((m.type || 'page') !== data.type) return false;
    if (data.type === 'element') {
      return pickedElement && (m.selector || '') === pickedElement.selector;
    }
    return true;
  });
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
  inputInterval.value = 1000;
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
  inputInterval.value = 1000;
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

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const check = document.createElement('button');
    check.className = 'btn-check';
    check.type = 'button';
    check.textContent = '立即检查';
    check.title = '立即执行一次检查';
    check.addEventListener('click', () => checkNow(m.id, check));

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
async function checkNow(id, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  hideStatus();
  try {
    if (!(hasChromeStorage && chrome.runtime && chrome.runtime.sendMessage)) {
      showStatus('本地预览模式不支持检查', true);
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: 'check-now', id: id });
    if (!res || !res.ok) {
      showStatus('检查失败，详见 Service Worker 日志', true);
    } else if (res.result === 'changed') {
      showStatus('检测到变化，已发送通知 ✓', false);
      renderUnread();
    } else if (res.result === 'not-found') {
      showStatus('未找到目标元素，页面结构可能已变化', true);
    } else {
      showStatus('暂无变化', false);
    }
  } catch (err) {
    console.error('[333 Watcher] check-now failed:', err);
    showStatus('检查失败，详见 Service Worker 日志', true);
  } finally {
    btn.disabled = false;
    btn.textContent = '立即检查';
  }
}

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
  await saveMonitors(monitors.filter((m) => m.id !== id));
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
    if (area === 'local' && changes.history) {
      renderUnread();
    }
  });
}

// ---- 初始化 ----
(async function init() {
  renderSyncBadge();
  renderUnread();
  renderList();
  const hasPick = await loadPendingPick();
  if (!hasPick) {
    fillFromActiveTab();
  }
})();
