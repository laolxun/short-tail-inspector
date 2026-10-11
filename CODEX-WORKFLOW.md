# Codex Panel 调用与章节验收（v0.2.2）

本文说明如何从 Obsidian 内的 Codex Panel 调用当前 Vault 安装的 short-tail-inspector，并核对本次实际渲染结果。插件负责在 Obsidian 阅读视图中测量布局；调用方不需要 Computer Use、截图或人工目测。

## 调用流程

1. 确认当前 Vault 路径及 `.obsidian/plugins/short-tail-inspector/manifest.json` 中的安装版本。使用该安装目录的 `scan-note.py`，不要拿开发目录副本替代正式 Vault 的入口。
2. 根据用户指定的笔记和章节读取当前 Markdown 源码。为嵌套章节构造完整 `headingPath`，保留标题原文和祖先路径；遇到重复标题或解析歧义时先澄清，不猜测、不静默改用行号。
3. 仅在用户授权本次扫描后，串行发起一个新请求。Target Scan 示例：

   ```bash
   python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" "目录/笔记.md" --vault "<vault>" \
     --target '{"kind":"section","headingPath":["笔记标题","5. 章节标题"]}' \
     --expected-source-sha256 "<当前源码 SHA-256>" \
     --expected-section-range "<起始行>:<结束行>" \
     --include-request --timeout 90
   ```

   `--expected-section-range` 用于核对章节边界，范围必须来自同一份源码快照。若目标是顶层章节，也可用 `--section`；嵌套章节应使用完整 `--target`。不因定位失败而静默改用 `--lines`。

## Obsidian 内部处理与布局参数

插件在处理请求时检查目标笔记是否在 Obsidian 主区域唯一打开；不满足时由插件返回错误，调用方无需先通过界面检查。插件会临时切换到阅读视图、收起侧栏、读取实际正文宽度和字号，并在扫描后尝试恢复原视图状态。

请求协议包含预期正文宽度和字号。`scan-note.py` 的默认值为 700px 和 16px；插件会在 Obsidian 内部读取实际值并核对是否匹配。调用方不应通过 Computer Use 读取界面、截图估算或猜测参数，也不应自动改 CSS 或反复尝试其他值。若布局校验失败，报告该次错误并停止；只有取得新的用户授权或可信布局参数后才可重新请求。

## 本次结果核对

以本次请求的 `requestId` 和 `archivePath` 为准，不用历史报告或可能被后续请求覆盖的 `report.json` 替代。核对 request、response 和 archive 中的身份、目标文件、源码 SHA-256 与目标路径一致；报告插件版本、扫描状态、扫描范围及以下结果字段：

- `targetCoverage=complete` 表示目标范围覆盖证明通过；`uncovered` 或 `error` 不算完整验收。
- `targetResult=clear` 或 `suspected` 表示检测结论。coverage complete 不代表没有疑似短尾。
- `documentCoverage` 是全文诊断；Target Scan 可出现 `documentCoverage=incomplete` 与 `targetCoverage=complete` 并存。
- `sectionPlan=ready` 表示章节 DOM 边界已建立，不单独证明内容覆盖。

若本次状态为 `incomplete`、`uncovered` 或 `error`，解释报告中的具体原因并停止；不自动重试，不用旧报告补齐结果。整个流程不修改笔记内容。

## 已知边界

章节范围来自完整 headingPath。重复路径或源码与 Obsidian metadata 无法一致确认时，不猜测边界。最后一章暂不支持 document-end 结束边界，可能返回 `sectionPlan=unavailable`。Beta 测试只验证其归档所列的章节和 Markdown 结构，不代表任意复杂内容都受支持。
