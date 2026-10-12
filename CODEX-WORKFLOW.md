# Codex Panel 调用工作流（v0.2.3）

本文说明如何从 Obsidian 内的 Codex Panel 调用当前 Vault 安装的 short-tail-inspector。插件在 Obsidian 阅读视图中测量实际布局，并返回疑似短尾及对应源码位置。

## 调用流程

1. 确认当前 Vault 路径及 `.obsidian/plugins/short-tail-inspector/manifest.json` 中的安装版本。使用该安装目录的 `scan-note.py`。
2. 按用户指定的笔记进行当前页面或全文扫描。当前页面可通过插件手动扫描 UI 获取报告；Codex 发起全文扫描使用以下命令，无需用户提供源码行号：

   ```bash
   python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" "目录/笔记.md" --vault "<vault>" --include-request
   ```

3. 从本轮 `archivePath` 读取疑似项及其 `sourceStartLine`、`sourceEndLine`、`domPath`、文本和源码 SHA-256。Codex Panel 使用这些输出参数核对当前源码并修改已授权内容；插件不负责理解标题或推断章节范围。
4. 修改后由 Codex 读取最新源码、核对文本位置并串行复扫。局部复扫参数由 Codex 从报告和最新源码生成，用户无需手填：

   ```bash
   python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" "目录/笔记.md" --vault "<vault>" \
     --lines "<起始行>:<结束行>" \
     --expected-source-sha256 "<当前源码 SHA-256>" \
     --include-request --timeout 90
   ```

   如需严格选择一个完整段落，Codex 可传入 `--target` 行范围及其原文，并使用 `--select-paragraph`。位置映射缺失或无法核对时报告原因，不猜测行号。

## Obsidian 内部处理与布局参数

插件在处理请求时确认目标笔记唯一打开，临时切换阅读视图、收起侧栏、读取实际正文宽度和字号，并在扫描后尝试恢复原视图状态。调用方无需通过界面预检或截图。

请求包含预期正文宽度和字号。`scan-note.py` 默认值为 700px 和 16px；插件会在 Obsidian 内部读取实际值并核对。不要通过截图估算、猜测参数或自动修改 CSS。布局校验失败时报告错误并停止。

## 本次结果核对

以本次请求的 `requestId` 和 `archivePath` 为准，不用历史报告或可能被后续请求覆盖的 `report.json` 替代。核对 request、response 和 archive 中的身份、目标文件、源码 SHA-256、扫描模式及目标行范围。

- `targetCoverage=complete` 表示目标源码范围的覆盖核对通过；`uncovered` 或 `error` 不算完整验收。
- `targetResult=clear` 或 `suspected` 是检测结论。覆盖完整仍可能有疑似短尾。
- `documentCoverage` 是全文扫描诊断；局部可见扫描不代表全文已经扫描。
- `archivePath` 对应归档的测量明细包含源码行和 DOM 路径，可用于在 Codex Panel 精确检查和修改已授权内容。

若本次状态为 `incomplete`、`uncovered` 或 `error`，报告具体原因并停止；不要用旧报告补齐结果。完成修改后读取最新源码并重新扫描同一位置，核对新源码哈希与本轮归档。

整个流程不自动修改笔记内容。请求邮箱只支持串行调用。
