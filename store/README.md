# 商店文案

`description.zh_CN.txt` 是提交到 Chrome Web Store 的「描述」字段正文，
请原样整份粘贴，**不要**在这里加注释或 Markdown 标记 —— 商店字段只接受纯文本。

## 重要：zip 里的文案不会自动同步到商店

`scripts/package.ps1` 会把本目录一起打进 zip，但 Chrome 商店**不会**解析 zip 内的
文本文件。文案只从开发者后台的表单字段读取，所以每次改文案仍然需要手动粘贴：

1. 打开 https://chrome.google.com/webstore/devconsole/
2. 进入 **333 Watcher** → 商店详情 → 描述
3. 全选并粘贴 `store/description.zh_CN.txt` 的内容
4. 保存并提交审核

把文案放进仓库和 zip 的目的：

- 文案与代码同仓、同版本、同 git 历史，改功能时能一起 review 差异
- 本地只需一个来源，不会出现「后台一份、仓库一份」互相抄漏
- 打包产物自带文案，交付或备份时不必另外找文件

## 改文案时的注意事项

- Chrome 商店描述上限 **132,500 字符**，当前约 2.4 KB，远未触顶
- 不要在正文里放版本号、更新日志、临时联系方式
- 涉及权限或数据处理的表述必须与 `PRIVACY.md` 保持一致
- 提到新功能时，`README.md` 的功能章节也应同步更新

## 相关脚本

仓库外的 `H:\Codex\chrome网页监视插件\cws-listing.mjs` 曾尝试通过 API 读写文案，
但实测 Google 已下线 v1.1 的 `items/{id}/listings` 路径，v2 对本 publisher 同样返回
404，因此该脚本目前仅作端点探测用途，不能代替手动粘贴。
