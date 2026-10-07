/**
 * 333 Watcher - 共享常量 (Single Source of Truth)
 *
 * background.js / add-monitor.js / picker.js / offscreen.js 都依赖这些数值。
 * Service Worker 不能直接 import ESM，故各文件仍内联常量；
 * 本文件作为校验锚点，由 scripts/check-constants.mjs 自动比对一致性，
 * 避免三处常量漂移。修改任一常量后请同步更新四处并跑 check-constants。
 */
export const DEFAULT_INTERVAL = 500; // 分钟，默认 500min (约 8h)
export const INVALID_THRESHOLD = 2; // 连续失败阈值
export const FETCH_TIMEOUT_MS = 20000; // fetch 超时 20s
export const MAX_HTML_BYTES = 2.5 * 1024 * 1024; // HTML 响应上限 2.5MB
export const MAX_JSON_BYTES = 512 * 1024; // JSON 响应上限 512KB
export const MAX_TEXT_VALUE_CHARS = 4096; // 文本值截断
export const MAX_URL_VALUE_CHARS = 2048; // URL 值截断
export const CLAIM_WINDOW_MULTI_MS = 5000; // 多设备仲裁窗口
export const CLAIM_WINDOW_SINGLE_MS = 600; // 单设备仲裁窗口
export const CLAIM_POLL_MS = 250;
export const ALARM_PREFIX = 'monitor-';
export const PRUNE_ALARM = '333-prune-history';
export const HISTORY_KEY = 'history';
export const HISTORY_LIMIT = 50;
export const HISTORY_MAX_BYTES = 7000;
export const HISTORY_READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEVICE_ID_KEY = '_333_device_id';