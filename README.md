# 333 Watcher

一个轻量、隐私优先的 Chrome 网页变化监控插件 — 整页 / 指定元素 (`text` / `href`) 定时检查，变化即通知。

> 商店：`gaakbhfclmmeholfdahnpkocdipijndo` · 源码：https://github.com/lijianbin2/333watch · 当前版本 **v0.6.19** (含首次检查基线：新建监控第一次检查只建基线不通知)

## ✨ 功能

- **两种监控**：整页 hash / 元素级（`CSS selector + text|href`，`src` 已于 v0.6.12 移除）
- **可视化拾取**：页面内 `🎯` 拾取对话框，属性由对话框决定（已移除旧下拉框）
- **定时检查**：`chrome.alarms`，关机不丢任务；默认 **500 分钟 ≈ 8 小时**（适合公告低频），可单条或批量改 5–60 分钟高频
- **通知**：`chrome.notifications` + 弹窗内小红点/横幅，未读可一键已读 / 清除已读（已读 7 天自动裁剪）
- **紧凑卡片** (v0.6.17)：单行 pill + 500m + 160px 等宽 selector + 相对时间，`watcher-time` 已隐藏，信息密度提升 ~35%
- **🧪 测试模式** (v0.6.16/0.6.17)：虚拟 `333-test://demo`，`text` / `href` 双路独立模拟变化 + 立即检查，零成本验证通知链路
- **🚨 失效提醒** (v0.6.18)：连续 2 次检查失败（网络/HTTP 错误，或元素·链接目标消失且自愈失败）自动发“监控失效”通知，列表标红 `已失效` 徽标并记原因；恢复正常再通知一次
- **同步**：`chrome.storage.sync` 配置与通知已读状态随 Google 账号多设备同步
- **管理**：立即检查、编辑/删除、批量间隔、历史折叠、全部已读

## 📦 安装

**商店安装（推荐）**
> v0.6.19 商店包已就绪（待上传），过审后自动更新

**开发者模式**
1. 打开 `chrome://extensions/` → 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `333-watcher` 目录
3. 固定到工具栏，点击图标打开

## 🚀 快速开始

1. 打开要监控的网页 → 点扩展图标
2. 选类型：整页 / 指定元素 → 点 `🎯 拾取` 在页面上点选元素
3. 改名称/间隔（默认 500m）→ 保存
4. 可选：用 `🧪 测试模式` 发一条模拟变更，确认通知能弹出；或点单条「立即检查」

## 🔧 商店发布（维护者）

```powershell
# 1. 改版后打包（已忽略 *.zip/crx/pem）
# manifest.json / background.js / add-monitor.* 头部保持版本一致

# 2. 发布（Publisher API v2，旧 v1 已停用）
$env:ACCESS_TOKEN="ya29...."  # 或 CLIENT_ID/SECRET/REFRESH_TOKEN
$env:ZIP_PATH="H:/Codex/chrome网页监视插件/333-watcher-0.6.19.zip"  # 脚本默认仍指向上版包，务必覆盖
node "H:/Codex/chrome网页监视插件/publish-cws.mjs"
# 底层：POST /upload/v2/publishers/00d922f1-2ce1-4252-9b44-a481ffe69180/items/gaakbhfclmmeholfdahnpkocdipijndo:upload
#       POST /v2/...:publish  |  查询：GET ...:fetchStatus
```

打包产物：`H:/Codex/chrome网页监视插件/333-watcher-0.6.19.zip`

## 📝 更新日志

- **v0.6.19** `first-check baseline` — 新建/改动监控的第一次成功检查只建立基线、不发变化通知；修复拾取文本 120 字符截断导致的首次必报；旧截断基线自动补全
- **v0.6.18** `invalid-target notify` — 失效提醒：连续失败 2 次通知失效（error/not-found 通用计数），`已失效` 红徽标 + `检查失败xN`，恢复通知
- **v0.6.17** `compact monitor cards` — 单行紧凑布局，隐藏冗余时间行，版本号全量同步
- **v0.6.16** `dual test mode` — `text`/`href` 双路测试，分离模拟 + 立即检查
- **v0.6.15** 测试模式（虚拟 URL + 模拟变更 + 立即检查）
- **v0.6.14** 拾取徽标 `?? → 🎯` UTF-8 修复
- **v0.6.13** 移除监控目标下拉（属性仅由拾取对话框决定）
- **v0.6.12** 移除 `src` 图片监控，元素模式保存按钮隐藏（对话框直接保存）
- **v0.6.10** 一键清除已读 + 60min 自动裁剪（7d）
- 更早见 `git log`

## 🔒 隐私

不采集、不上报、不含广告/统计。仅向你添加的监控网址发请求检查变化，数据存于 `chrome.storage.sync`。详见 [PRIVACY.md](./PRIVACY.md)

## 🛠 开发

- Manifest V3，`service_worker: background.js`，`offscreen.js` 辅助
- 纯前端，无后端；权限 `storage/notifications/alarms/activeTab/scripting/offscreen` + `<all_urls>`

---
Made for 333 — 提 Issue: https://github.com/lijianbin2/333watch/issues
