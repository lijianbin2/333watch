# 333 Watcher

333 Watcher 是一个隐私优先的 Chrome 网页变化监控扩展。它可以定时检查整个网页，也可以只检查页面中的某个元素；当内容发生变化时，通过 Chrome 通知提醒你。

当前版本：**v0.6.21**

商店状态：v0.6.21 已提交 Chrome Web Store 审核，状态为 `PENDING_REVIEW`（2026-09-24）

商店扩展 ID：`gaakbhfclmmeholfdahnpkocdipijndo`

源码仓库：<https://github.com/lijianbin2/333watch>

## 功能

- **整页监控**：定期抓取网页 HTML，使用内容 hash 判断页面是否发生变化。
- **元素监控**：通过可视化拾取生成 CSS selector，监控元素的文本或链接变化。
- **多目标共存**：同一页面可以同时监控整页、多个不同元素，以及同一 selector 的不同属性。
- **定时检查**：使用 `chrome.alarms` 调度任务，默认间隔为 500 分钟，可在界面中调整。
- **变化通知**：支持 Chrome 通知、未读计数、变化历史和已读管理。
- **失效提醒**：连续检查失败或目标消失时显示失效状态，恢复后发送恢复提醒。
- **配置同步**：监控配置、通知历史和已读状态存储在 `chrome.storage.sync`，可随 Chrome 账号同步。
- **跨设备去重**：一条变化在 A 电脑被标记为已读后，其他电脑不会再次弹出同一条提醒。
- **测试模式**：使用内置的虚拟页面模拟文本或链接变化，便于验证通知链路。
- **导入导出**：支持复制 JSON 配置到其他设备或浏览器环境。

## 监控类型

| 类型 | 检查目标 | 说明 |
| --- | --- | --- |
| 整页 | 页面 HTML hash | 适合公告、新闻、状态页等整体内容变化 |
| 元素文本 | CSS selector + `text` | 适合价格、库存、标题、状态文字等 |
| 元素链接 | CSS selector + `href` | 适合下载链接、跳转地址、按钮目标等 |

监控目标按以下规则区分：

- 整页目标按规范化后的 URL 去重；
- 元素目标按 URL、selector 和 attribute 组合去重；
- 只有完全相同的目标才会更新原监控；
- 删除一个元素不会影响同一页面的其他监控。

## 安装

### Chrome Web Store

在 Chrome Web Store 中搜索 **333 Watcher**，或使用扩展 ID：

`gaakbhfclmmeholfdahnpkocdipijndo`

### 开发者模式

1. 打开 `chrome://extensions/`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本仓库的 `333-watcher` 目录。
5. 将 333 Watcher 固定到浏览器工具栏。

## 使用方法

### 创建监控

1. 打开需要监控的网页，点击工具栏中的 333 Watcher。
2. 选择“整页”或“指定内容”。
3. 如果选择指定内容，点击“拾取元素”，在网页中选择目标元素。
4. 根据需要填写名称和检查间隔。
5. 点击“保存监控”。

新建或修改监控后，第一次成功检查只建立基线，不会因为初始内容而发送变化通知。后续检查发现内容变化时才会通知。

### 管理监控

在扩展面板中可以：

- 立即检查单条监控；
- 编辑名称、URL、selector 和检查间隔；
- 删除单条监控；
- 批量更新检查间隔；
- 展开变化历史；
- 标记全部历史为已读；
- 清除已读历史。

### 跨设备提醒

监控配置、通知历史和已读状态会随 Chrome 账号同步。变化提醒带有稳定的事件标识；当你在 A 电脑将提醒标记为已读后，B 电脑同步到该记录时，会跳过相同提醒，不会因为检查任务在另一台电脑运行而重复弹出。

该规则只抑制“已经读过”的同一事件，不影响新的变化、失效提醒或恢复提醒。Chrome 同步有短暂延迟时，若两台电脑恰好同时检查并同时发送，仍可能各弹出一条；在 A 电脑完成已读后切换到 B 电脑的常见场景不会再重复提醒。

### 测试通知

测试模式提供独立的文本和链接模拟页面，可以在不访问真实网站的情况下验证：

1. 打开扩展面板中的测试模式。
2. 选择文本或链接测试项。
3. 模拟一次变化并执行立即检查。
4. 确认 Chrome 通知和未读状态正常更新。

## 工作方式与边界

### 页面检查

整页监控会请求用户配置的 URL，移除 HTML 中的注释、脚本、样式和 `noscript` 内容后计算 hash。页面首次检查只建立基线。

### 元素检查

元素监控先读取页面对应的 HTML，再在受限的 DOM 环境中定位 selector，并读取文本或 `href` 属性。文本查找优先返回最深的叶子节点，避免外层容器抢占匹配结果。

### 资源和安全限制

- 网络请求超时：20 秒；
- HTML 响应大小上限：2.5 MB；
- JSON 响应大小上限：512 KB；
- DOM 扫描上限：50,000 个节点；
- 检查间隔范围：1–10,080 分钟；
- 文本监控值最多保存 4,096 个字符；
- 链接监控值最多保存 2,048 个字符；
- 导入数据会进行结构清洗和长度限制；
- 同步存储空间不足时，界面会显示可操作的错误提示。

## 隐私

333 Watcher 不包含广告、统计或第三方分析服务。

- 不会把监控配置上传到本项目服务器；
- 不会上传通知历史；
- 仅向用户主动添加的监控 URL 发起检查请求；
- 配置和通知历史存储在浏览器的 `chrome.storage.sync` 中；
- 元素拾取只在用户主动操作时使用。

详细说明见 [PRIVACY.md](./PRIVACY.md)。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存监控配置、历史和已读状态 |
| `notifications` | 发送变化、失效和恢复通知 |
| `alarms` | 定时执行检查任务 |
| `activeTab` | 在当前页面执行用户主动触发的拾取操作 |
| `scripting` | 读取用户指定页面中的元素信息 |
| `offscreen` | 在受限环境中解析 HTML 和定位元素 |
| `<all_urls>` | 允许检查用户主动添加的任意 HTTP/HTTPS 网址 |

## 开发

### 文件结构

```text
333-watcher/
├─ manifest.json       # Manifest V3 配置
├─ background.js       # Service Worker、检查、通知、存储和调度
├─ add-monitor.html    # 扩展面板
├─ add-monitor.js      # 面板交互和监控 CRUD
├─ add-monitor.css     # 面板样式
├─ picker.js           # 页面元素拾取脚本
├─ offscreen.html      # Offscreen Document 页面
├─ offscreen.js        # HTML 解析和元素查询
└─ icons/              # 扩展图标
```

### 本地检查

在仓库根目录运行：

```powershell
node --check background.js
node --check add-monitor.js
node --check picker.js
node --check offscreen.js
git diff --check
```

### 发布前检查

1. 确认 `manifest.json`、页面页脚和脚本头部版本号一致。
2. 运行 JavaScript 语法检查和 `git diff --check`。
3. 在 Chrome 开发者模式中测试整页、元素文本和元素链接监控。
4. 确认 ZIP 不包含 `.git`、凭据、调试文件或其他私密内容。
5. 先上传新版本 ZIP，再提交 Chrome Web Store 审核。

### 打包与发布

发布脚本位于仓库上级目录的 `publish-cws.mjs`。它使用 Chrome Web Store Publisher API，认证信息应通过环境变量提供，不要提交到 Git：

```powershell
$env:ACCESS_TOKEN="<access-token>"
$env:ZIP_PATH="<path-to>/333-watcher-0.6.21.zip"
node "<path-to>/publish-cws.mjs"
```

如果本机使用代理，可在当前 PowerShell 会话中设置：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7890"
$env:HTTPS_PROXY="http://127.0.0.1:7890"
node --use-env-proxy "<path-to>/publish-cws.mjs"
```

## 更新日志

### v0.6.21

- 修复在 A 电脑已读提醒后，切换到 B 电脑仍收到同一提醒的问题；
- 为变化、失效和恢复提醒增加稳定事件标识；
- 已读状态通过 `chrome.storage.sync` 跨设备生效，并兼容 v0.6.20 及更早版本的历史记录；
- 更新版本号、README 和发布说明。

### v0.6.20

- 增加网络请求超时和响应大小限制；
- 整页和元素监控按目标去重，同一页面支持多个元素共存；
- 修复 picker 和 offscreen 的 CSS selector 生成及特殊字符处理；
- 改进同步存储配额错误提示；
- 删除操作改为只删除单条监控；
- 增强导入数据清洗和长度限制；
- 改进文本匹配和 DOM 扫描边界。

### v0.6.19

- 新建或修改监控的第一次成功检查只建立基线，不发送变化通知；
- 修复首次检查因文本截断而误报的问题。

### v0.6.18

- 增加连续检查失败和目标失效提醒；
- 增加失效状态徽标和恢复通知。

更早的变更记录请查看 [Git 提交历史](https://github.com/lijianbin2/333watch/commits/main/)。

## 贡献

欢迎通过 GitHub Issue 报告问题或提出建议：

<https://github.com/lijianbin2/333watch/issues>

## License

本项目遵循仓库中的许可协议。发布、分发或二次修改前，请先阅读对应许可文件。
