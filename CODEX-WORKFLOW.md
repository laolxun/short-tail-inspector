# Codex Panel 当前视口捕捉、定点优化与局部复检

插件只提供检测和身份校验；文字优化、授权判断和文件修改由 Codex 执行。实现与测试不授权部署或改写 Vault。本工作流只在新版本已获授权安装、用户已授权具体笔记目标修改后执行。

## 当前视口捕捉

1. 用户要求当前视图时，先自动检查 Codex Panel 本轮消息注入的活动文件上下文，取得准确、可验证的 Vault 相对路径；不要求用户额外提醒“查看当前上下文”。本轮消息缺少可验证路径时，不猜测、不用文件名搜索替代、不回退其他模式，明确说明缺少路径上下文，并提示用户检查 Reference active file on send 设置后重新发送。不读取截图或窗口来重复识别文件。文件上下文仅供读取和定位，不构成修改笔记的授权。
2. 确认 Vault 路径后，使用安装目录的 `scan-note.py` 显式传入路径和 `--visible-only`；可先检查安装脚本 `--help`。不使用已移除的 `--visible-active`。请求必须串行：

   ```bash
   python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" \
     "<从当前文件上下文取得的Vault相对路径>" \
     --vault "<vault>" --visible-only --include-request --timeout 90
   ```

   插件按显式路径要求目标笔记唯一打开且可见；条件不符时明确失败，不另选笔记。插件保存视图、侧栏与阅读滚动位置，临时收起侧栏、切到阅读视图，等待字体与布局稳定。使用实际正文宽度和字号，仅执行一次当前视口测量，不定位滚动、不遍历全文、不修改 CSS。最后尝试恢复原状态；恢复失败响应为 error。范围以收栏后的稳定视口为准。
3. 以本轮 request 和 response 的 id、响应 archivePath 读取归档，不用历史报告或 report.json 替代。脚本核对笔记路径、源码 SHA-256、模式、次数和覆盖。显式路径视口使用请求/响应 schemaVersion=3、归档 schemaVersion=4；请求绑定调用前读取的源码哈希，响应和归档必须与本轮请求一致。收到响应及输出前再次核对源码；身份或源码校验失败停止消费结果。
4. 先核对本轮请求、响应和归档身份及最新源码哈希；允许 `status=complete` 或 `status=incomplete`，模式必须为 `scanMode=visible`、`completionScope=viewport`、`scanMethod=visible`、`documentCoverage=not-scanned`。`status=complete` 对应 `visibleCoverage=complete`，`status=incomplete` 对应 `visibleCoverage=uncovered`。`scan.full=false`、`scan.steps=1`、`scan.complete=false`：最后一项是全文诊断，不等于本次视口失败。实际布局记录在归档 layout。
5. `incomplete/uncovered` 不丢弃局部有效结果：读取本轮归档，展示 `capture.coverage=complete` 且 `suspected=true` 的段落及其源码位置，同时明确列出表格、未知文本等未覆盖原因。响应 `suspected` 是已确认的局部疑似数量；不能仅凭原始块的 `suspected` 标记认定有效。即使数量为零，也只能说“已确认范围未发现疑似项，视口仍有未检测内容”，不能说整个视口无寡行。CLI 此时退出 1 并输出本轮结果，不能按一般执行异常丢弃 stdout。error、超时、身份不一致或源码变化时停止消费结果；始终禁止全文回退和旧报告替代。
6. 代码块在 `skipped` 中保留范围与 `coverage=excluded`，按设计不检测代码文本，不单独导致未覆盖；映射不可信不能排除。表格仍为 `uncovered`，不新增测量能力。视口只有排除内容时没有正文测量结论。

## 核对并只改本轮目标

1. 只考虑身份校验通过的本轮归档中 `capture.coverage=complete`、`suspected=true` 且 `capture.eligibleForEdit=true` 的完整段落，结合 capturedTargets 的完整范围与原文、块 key/domPath/sourceMapping、measurementUnit 及测量几何核对身份。检查 `capture.editReasons`：只有已有源码映射范围恰好等于唯一 `paragraph` 区块、仅关联一个测量节点且 P 不在引用、Callout 或列表内，才可能可编辑。该判断不产生新行号、不按文本重新定位；同文的两个独立段落仍按各自原有范围区分。保护代码块；无法把渲染段落唯一对应到可独立修改的源码时跳过，尤其不能直接替换拥有多个段落的整个引用、列表或 Callout 容器。
2. 重新读取笔记原始字节，确认 SHA-256 与本轮捕捉一致，并逐字核对源码起止行及原文。DOM 文本可能已经去掉 Markdown 标记，不能直接当作源码替换内容。哈希变化时重新核对所有目标及其上下文；无法可靠证明仍是原目标则跳过，不搜索首个同名段落代替。
3. 在用户授权的目标集合内生成优化文本，精简冗余并保留原意与 Markdown 结构。每项记录捕捉身份、原始范围、原文和拟修改文本；未捕捉段落、范围外文字和代码不得改动。
4. 多目标在同一已核对的源码快照上按起始行倒序修改，拒绝重叠目标。先在内存形成拟写结果并检查差异只包含已授权目标；落盘前再次核对整个文件哈希。若有外部变化，停止写入并重新核对，不能用旧缓冲覆盖。
5. 写入后重读文件并核对实际内容。根据每个目标新增/减少行数，按源码顺序累计行偏移，生成修改后的精确范围及完整源码原文；逐项核对实际切片。不可靠的位置跳过并报告。不得沿用旧行号或用旧哈希复检。

本仓库不提供自动编辑命令；以上是 Codex 调用方的执行约束。`tests/visible-workflow-test.py` 只在临时合成笔记中验证这一调用契约，不能证明实际改写语义合格或实际 Codex 操作已执行。

## 禁止全文回退的局部复检

只对本轮实际修改的目标调用；优先逐目标串行，每次使用当前源码 SHA-256：

```bash
python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" "目录/笔记.md" --vault "<vault>" \
  --local-only \
  --target '{"kind":"lines","startLine":12,"endLine":13,"text":"修改后第一行\n第二行"}' \
  --expected-source-sha256 "<修改后源码 SHA-256>" --include-request --timeout 90
```

也可使用 `--lines "12:13"`，脚本从当前源码自动绑定原文。`--local-only` 要求显式行目标和哈希，拒绝仅段落文本搜索。`--target` 可重复，但多目标不能同时完整可见时会未覆盖；不会自动拆分请求或启动全文循环。

插件复用已有同步刷新与单目标可信定位；可进行一次定位滚动以使目标完整可见，然后只进行一次视口测量并筛选目标。无法定位时仍只测量一次当前视口并返回 uncovered，异常直接失败。请求是 `scanMode=targets`、`localOnly=true`；响应必须是 `completionScope=targets`、`scanMethod=visible`、`documentCoverage=not-scanned`。归档 targeting 的 requested、ranges、覆盖证据、计数和结果必须与本轮请求响应一致。完整局部复检也不会声明全文通过。

严格选择复杂源码容器内的一个完整 P 节点时，可以继续使用原有 `--select-paragraph` 配合精确容器原文、哈希及 `--include-request`，但修改边界仍须独立核对；无法证明时跳过。

## 结果交付与兼容性

逐项报告原文、修改后文本、新范围、复检 requestId/archivePath、SHA-256、targetCoverage 和 targetResult。clear、仍 suspected、uncovered/error/未复检分别报告；疑似不等于允许继续扩写，局部结果不代表全文通过。没有实际修改笔记时不要虚构逐目标结果。

旧调用不带上述新选项时保持兼容：无目标为 schema 1 全文扫描，有目标为 schema 2 原有目标扫描（可能回退全文）。本工作流当前视口统一从本轮活动文件上下文取路径，显式传 `--visible-only`；局部复检传 `--local-only`，不得误用旧接口作为兜底。旧接口仍使用预期宽度/字号（默认 700px/16px），新接口直接读取实际布局。所有扫描必须有有效笔记路径；schemaVersion 4 请求及 `fileSelector` 选择字段不再支持。

## 真实 Obsidian 验收（待另行授权部署）

- 从 Pano 开启 Reference active file on send 后发送当前视图扫描请求，确认本轮注入的路径正确；切换笔记后重新发送，确认路径更新。关闭设置或缺少可验证路径时必须提示并停止，不搜索或猜测文件。
- 在阅读模式与编辑模式的测试笔记中置于中部，打开侧栏并记录滚动位置；按本轮上下文路径调用 visible-only，确认只捕捉收栏后视口、scan.steps=1、无全文滚动，完成后原模式、侧栏及位置恢复。
- 分别测试预先关闭的侧栏、源码模式、边界裁切、代码块、复杂 Callout、无映射和空白视口；不得错误返回完整或全文通过。
- 另行授权两个完整段落修改，其中一个增加或减少源码行；仅复检实际修改后的两个目标，核对新范围、原文、哈希及邻近段落未改。目标过长或未渲染时应未覆盖，无全文回退。
- 路径无效、目标未打开或重复打开时确认明确失败，无全文回退；单纯提供文件上下文不得触发笔记修改。
- 扫描前及扫描中修改文件，测试阅读视图未同步、布局变化和异常路径，确认失败不会导出可接受结果且恢复仍被尝试。核对本轮请求、响应和归档身份。
- 浏览器几何与 API 替身测试不能替代这些真实 Obsidian 验收。本任务禁止部署，以上尚未执行。
