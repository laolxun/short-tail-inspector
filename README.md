# 短尾行检测原型 v0.2.4（范围收敛）

读取 Obsidian 阅读视图实际渲染的字符位置，判断疑似短尾并返回精确源码位置，供 Codex Panel 检查和修改。插件不改写笔记、不调整 CSS、不截图、不联网。

## v0.2.4 范围

- 当前页面渲染扫描：检测当前稳定视口内完整可见的文本；由 Codex Panel 本轮消息的活动文件上下文取得路径，再使用显式路径的 `--visible-only` 请求入口，仅测量一次，不回退全文。
- 全文笔记扫描：逐屏检测全文，并核对扫描是否完整。
- 报告疑似短尾、测量明细、源码起止行和 DOM 路径。
- Codex Panel 可按精确源码行或完整段落文本发起目标检测；单个可信目标可局部扫描，无法安全局部定位时回退全文扫描并筛选目标。
- 新增 `--local-only` 目标复检：实测布局、绑定最新源码及精确目标，不回退全文；旧目标接口保留原有回退行为。
- 不解析章节路径，不推断章节边界，不提供固定章节范围扫描。

扫描保留正文、行内代码、自定义 `[!K]` Callout、引用及列表文本的测量能力。所有 PRE/fenced code block 均跳过测量和疑似判断，不按语言区分；报告保留跳过类型、源码位置、DOM 路径和原因。其余文本中，每个主动断行片段独立判断；只有自动折成多行且末行不足可用宽度 25% 才标为疑似。疑似结果不等同于允许改写。

主题或 CSS 改变字体、宽度、缩进及留白时，换行和结果可能变化。700px、16px 和测试夹具中的 `linux-notes` CSS 类来自作者验证环境，不是算法硬编码要求。

## 手动扫描

打开笔记的阅读视图，在命令面板选择：

- 短尾行检测原型：检测当前阅读视图短尾行
- 短尾行检测原型：检测并导出当前阅读视图报告
- 短尾行检测原型：检测整篇阅读视图短尾行
- 短尾行检测原型：扫描整篇阅读视图并导出报告

结果窗口显示文件名、扫描模式、已测/疑似/跳过数量，疑似项与测量明细可折叠查看。扫描报告支持选择并复制文本，方便在 Obsidian 中快速搜索定位疑似寡行位置。前两项扫描当前视口；后两项逐屏扫描整篇并在完成后恢复滚动位置。手动与 Codex 请求共用测量和报告机制。

## Codex Panel 调用

用户要求当前视图、当前页面可见区域或当前屏幕中的寡行时，Codex 必须先自动检查 Codex Panel 本轮消息注入的活动文件上下文，取得准确、可验证的 Vault 相对路径，不要求用户另行提醒“查看当前上下文”。确认路径后，使用安装目录的脚本：

```bash
python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" \
  "<从当前文件上下文取得的Vault相对路径>" \
  --vault "<vault>" --visible-only --include-request --timeout 90
```

不读取截图、窗口、选区来重复识别文件，不猜测路径，不用文件名搜索替代，不回退全文或目标扫描。本轮消息缺少可验证路径时，明确说明“缺少当前活动文件路径上下文，请检查 Reference active file on send 设置后重新发送”，停止发起扫描。文件作为上下文提供不等于授权修改文件；检测请求只授权检测。

插件不再提供 `--visible-active` 或活动文件选择协议；所有扫描必须提供有效笔记路径。调用前可检查安装脚本 `--help`。插件根据显式路径选择唯一打开且可见的目标笔记，使用收栏后的稳定视口，不滚动全文。调用方无需猜测布局或手填段落范围。

显式路径接口使用请求 schemaVersion 3，`scanMode=visible`；响应 schemaVersion 3、归档 schemaVersion 4，`completionScope=viewport`、`scanMethod=visible`、`documentCoverage=not-scanned`。`visibleCoverage=complete` 只表示本次捕捉源区块核对完整，不代表全文通过。边界裁切、未知映射、未支持表格等实质内容或测量不完整返回 `incomplete/uncovered`，异常返回 `error`，均不回退全文。收栏可能改变换行，捕捉范围以收栏后布局为准。

报告保留实测 `layout`、`capturedTargets`（含精确源码原文及行范围）和逐块 `capture`。本轮请求身份、源码哈希和归档校验通过后，即使 `status=incomplete`、`visibleCoverage=uncovered`，也须读取归档中的逐块结果：`capture.coverage=complete` 且 `suspected=true` 是可展示的局部疑似项，附源码行号和 DOM 路径。响应 `suspected` 仅统计这些已确认的局部疑似项；原始测量块中的疑似标记可保留为诊断，未覆盖块不能算作有效结果。只有块原有 `capture.eligibleForEdit=true` 时才可继续核对修改；展示结果不构成修改授权。当前候选限定能够唯一对应独立 Markdown 段落的疑似项：已有映射范围须恰好等于唯一的 `paragraph` 源区块、只关联一个测量节点，且该 P 节点不在引用、Callout 或列表内。完整 P 测量不等于独立源码段落；这些容器中的段落保留原测量和映射，但 `eligibleForEdit=false`。`capture.editReasons` 说明拒绝原因，可编辑性拒绝不改变扫描覆盖结论。

`visibleCoverage=uncovered` 时必须同时报告未检测内容，不能断言视口无其他寡行；零个已确认疑似项也不等于完整的“无寡行”。CLI 此时仍退出 1，但在身份校验通过后输出有效的 request/response 和 archivePath，调用方不得因非零退出码直接丢弃局部结果。error、超时、身份或源码校验失败才停止消费结果，且不得全文回退。

受保护代码块留在 `skipped`，带原有源码范围、映射身份及 `coverage=excluded`，不因代码文本未测量而造成视口失败；不可信的代码映射不能被排除。表格和其他测量失败项标记 `coverage=uncovered`。只有排除内容的视口可以完成覆盖核对，但没有正文测量结论；不得称为代码已检测通过。

以下旧接口继续扫描全文；将 `<vault>` 和笔记路径替换为实际值：

```bash
python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" "目录/笔记.md" --vault "<vault>"
```

用户只需指定笔记及扫描模式。扫描报告自动输出 `sourceStartLine`、`sourceEndLine`、`domPath`、文本和源码 SHA-256；Codex Panel 据此定位疑似项并核对当前源码，不要求用户手填行号。需要局部复扫时，Codex 从本轮报告提取 1-based 闭区间行号并绑定最新源码 SHA-256：

```bash
python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" "目录/笔记.md" --vault "<vault>" \
  --lines "12:16" --expected-source-sha256 "<当前源码 SHA-256>" --include-request
```

`--target` 支持 `kind=lines` 和 `kind=paragraph`；`--paragraph` 支持精确段落文本。章节目标和 headingPath 不属于当前接口。严格选择一个完整渲染段落时，使用精确行范围、原文、`--select-paragraph`、源码 SHA-256 和 `--include-request`。

`--vault` 为必填参数。`--visible-only` 和 `--local-only` 直接读取实际布局，不发送预期宽度/字号；`--width`、`--font-size` 仅作用于旧接口。旧接口默认预期正文宽度为 700px、字号为 16px；仅使用可信的其他布局值时传入 `--width` 和 `--font-size`。插件在 Obsidian 内读取真实布局并核对，不会更改 CSS。调用方无需截图或界面预检。

只对本轮已授权、已修改的目标进行复检时，使用新接口；行号和 SHA-256 均由 Codex 读取修改后的源码生成：

```bash
python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" "目录/笔记.md" --vault "<vault>" \
  --local-only --target '{"kind":"lines","startLine":12,"endLine":13,"text":"修改后的完整源码第一行\n第二行"}' \
  --expected-source-sha256 "<修改后源码 SHA-256>" --include-request
```

`--local-only` 必须绑定最新哈希和精确行目标，禁止文本搜索猜测定位；指定原文时必须与该范围逐字一致。使用 `--lines` 时脚本自动从当前源码绑定范围原文。单目标可通过已有可信定位进行一次局部定位滚动；无法定位、目标过长、多目标不同时可见等情况返回未覆盖，不启动全文循环。建议按修改目标串行调用；复检仅返回指定目标，不代表邻近段落或全文通过。完整操作与多目标行号偏移处理见 `CODEX-WORKFLOW.md`。

请求、响应和最新报告写入插件目录的 `request.json`、`response.json`、`report.json`。每次保存的报告单独写入 `reports/`。调用方按本轮 `requestId` 和 `archivePath` 校验请求、响应、归档、文件和源码 SHA-256；不要用可能被后续保存替换的 `report.json` 代替归档。

所有可信归档达到 20 份后清理到最新 5 份。旧归属不明、人工创建或内容校验不一致的文件保留。保存失败不会触发清理。报告是临时检测记录，不是知识笔记备份。

请求入口每 500ms 检查单个请求邮箱；调用方必须串行请求。调用流程：Obsidian 页面或全文扫描 → 输出疑似项和位置参数 → Codex Panel 核对源码并在授权范围内修改 → 再次扫描验证。修改导致行号变化时，Codex 根据最新源码重新核对文本位置。扫描本身不修改笔记。

## 定位和覆盖

行范围必须有效且与源码一致。插件把测量结果关联到源码区块、源行和 DOM 路径；不完整映射、未支持内容、隐藏或裁切内容、测量失败及不完整扫描不会被报告为通过。全文 `documentCoverage` 与目标 `targetCoverage` 分别表达全文扫描和目标范围的覆盖情况。

源码定位优先校验实时 Obsidian 区块信息；失效候选继续查找可信祖先，缓存回退须校验注册时的源码版本和 owner 状态，不按文本猜测行号。报告中的 `sourceMapping` 记录定位状态、依据及候选失败原因；`renderDomPath` 独立记录相对阅读容器的 DOM 路径。原 `domPath` 仍相对源码 owner，映射失败时保持为空。这些诊断不代表目标覆盖已经通过；真实 Obsidian 的定位验证仍须单独完成。

短尾比例 25% 是筛查阈值，不是排版规范。列表、代码、Callout、主题和 Obsidian DOM 的组合仍需根据具体报告判断。合成浏览器与 API 替身测试不能代替真实 Obsidian 验证。

## 开发与验证

仓库根目录是权威开发源码；`<vault>/.obsidian/plugins/short-tail-inspector/` 是运行副本。更新关系为开发源码 → 验证后安装副本 → Obsidian 加载。没有自动构建或部署流程；部署需单独授权，并须保护插件运行数据。

常用回归入口：

```bash
node tests/regression.cjs
node tests/codeblock-skip.cjs
node tests/source-mapping.cjs
node tests/target-scan.cjs
node tests/callout-coverage.cjs
node tests/manual-layout.cjs
node tests/request-protocol.cjs
node tests/report-store.cjs
python3 -B tests/scan-note-test.py
python3 -B tests/target-workflow-test.py
node --test tests/target-ranges.cjs
node tests/paragraph-units.cjs
python3 -B tests/paragraph-workflow-test.py
python3 -B tests/visible-workflow-test.py
node tests/mode-editability.cjs
node tests/visible-partial.cjs
```

浏览器测试需要可解析的 Playwright 与 Chromium；可通过 `PLAYWRIGHT_MODULE` 和 `CHROME_EXECUTABLE` 指定已有依赖。测试替身不证明真实 Obsidian 布局、刷新、文件同步或侧栏恢复。

当前视口请求与局部复检的自动化验证包含真实浏览器几何测量和 Obsidian API 替身；尚需在另行授权部署后验证真实 Obsidian 的当前视口、侧栏动画、文件同步及异常恢复。本次实现不包含部署或自动改写笔记的引擎。

仍需在另行授权部署后验证真实 Codex Panel 的 Reference active file on send 设置：开启时本轮消息是否提供准确 Vault 路径、切换笔记后是否更新、关闭或缺少上下文时是否提示并停止。还需验证真实 Obsidian 的显式路径视口、阅读/编辑模式及异常恢复；测试通过不证明安装副本已更新或 Obsidian 已加载新实现。
