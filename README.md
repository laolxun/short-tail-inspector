# 短尾行检测原型 0.2.2

读取 Obsidian 实际渲染的字符位置。检测不改写笔记，不调整现有 CSS，不截图、不联网。

## 已实现

- 正文、行内代码、K 知识块、引用、列表内段落、紧凑列表文本
- 代码块按源码行分别检测，区分主动换行与同一行的视觉折行
- 嵌套缩进与块内留白采用当前元素的实际可用宽度
- 每个主动断行片段独立判断；只有自动折成多行且末行不足可用宽度 25% 才标为疑似
- 全文逐屏扫描：源区块位置与 DOM 路径去重，保留文字相同但位置不同的段落
- 记录源文件 SHA-256；内容、模式或宽度变化时停止扫描
- 核对遍历末尾与源区块覆盖；不完整结果不标为完整通过
- 完成或中断后恢复原滚动位置
- 供 Codex 调用的本地文件请求入口
- 指定章节、段落或 1-based 源码范围；可信单目标一屏扫描，否则全文回退并筛选
- 所有成功保存报告累计达到 20 份后批量清理至最新 5 份；旧归属不明报告保留

“K 知识块”是作者知识库使用的自定义 `[!K]` Obsidian Callout，不是 Obsidian 标准内容类型。源码仅将 `.callout[data-callout="k"]` 内的文本标记为“K知识块”；其测量使用相同的段落和列表逻辑，没有针对 `k` 的专用扫描算法。

插件根据当前实际渲染的字符位置和元素可用宽度测量。主题或 CSS 改变字体、宽度、缩进及留白时，换行和短尾结果可能合理改变。700px、16px、关闭侧栏和测试夹具中的 `linux-notes` CSS 类来自作者验证环境，不是核心算法的硬编码要求；仓库不提供该自定义 CSS。

25% 只是筛查阈值，不是排版规范。代码、配置和字符图的内容受保护；疑似短尾不代表允许改写技术内容。

## v0.2.2 版本说明

### 版本目标

从基础短尾检测升级为基于 Obsidian 阅读视图真实渲染结果的章节级检测。插件测量实际显示布局，并区分目标章节覆盖状态与短尾检测结果。

### 新增与完善能力

1. **headingPath 章节定位**：调用方可用完整标题路径指定章节，例如 `{"kind":"section","headingPath":["笔记标题","5. 章节标题"]}`。它解决同名标题、嵌套章节以及仅按全文扫描难以确认目标范围的问题；插件解析路径并返回对应源码范围。
2. **sectionPlan 章节范围识别**：根据目标标题和后续标题证据建立章节 DOM 连续范围。`ready` 表示边界证据通过；`unavailable` 表示无法安全确认边界。它只证明章节边界，不等于章节内容已完整覆盖。
3. **targetCoverage**：报告指定目标自身是否已被充分检测，可为 `complete` 或 `uncovered`。它与检测结果分开：完整覆盖后仍可能是 `clear` 或 `suspected`；全文 `documentCoverage=incomplete` 可以与目标章节 `targetCoverage=complete` 并存。
4. **mappingPrecision / mappingGap**：记录 DOM 内容到 Markdown 源码范围的定位精度及映射缺口。章节边界 ready 且有成功测量 blocks 时，单独的源码映射缺口降为 `mappingPrecision=partial` 诊断，不再直接阻断目标覆盖；缺少预期区块、没有成功测量、unsupported 内容或明确渲染异常仍会阻断。这样可报告检测结果，同时明确源码行定位精度有限。
5. **request / response / archive**：每次调用以唯一 `requestId` 关联请求、响应和归档报告，校验目标文件及源码哈希，并通过 `archivePath` 找到本次结果，避免误读旧响应或旧报告。

### v0.2.2 Beta 已验证能力

以下结果来自 2026-10-11 的真实 Obsidian 阅读视图扫描，归档均记录 `pluginVersion=0.2.2`：

- **Normal Section**：`requestId=9da0fb83836c467fa62b854680572cb6`，`sectionPlan=ready`、`targetCoverage=complete`、`targetResult=clear`，测量 2 个 blocks，疑似 0。
- **Short Tail Section**：`requestId=d661b671c1c545b0bc393d906b068800`，`sectionPlan=ready`、`targetCoverage=complete`、`targetResult=suspected`，测量 2 个 blocks，发现 1 个疑似短尾。
- **Complex Markdown Section**：`requestId=850f5dd5ad3a46a1ae7d7cad6e73fb6e`，`sectionPlan=ready`、`targetCoverage=complete`、`targetResult=suspected`，测量 6 个 blocks，发现 1 个疑似短尾。该案例覆盖了测试中的列表、引用和代码结构，说明这些实际测试内容没有导致 coverage 失败；不代表所有 Markdown 格式均受支持。

这三个 Beta 归档均为 `mappingPrecision=exact`、mapping gap 数量为 0。因此它们没有直接验证“存在 mappingGap 时仍完成章节覆盖”的情形；该行为另有开发回归测试记录，不应与本次真实渲染结果混为一谈。目标扫描的 `documentCoverage` 不完整不改变上述目标级结论。

### 已知限制

最后一个章节没有后续标题时，当前章节结束边界仍有限：不支持以 document-end 作为可靠结束边界，`sectionPlan` 可能返回 `unavailable`。复杂嵌套结构在边界证据不足时也会保守失败。

### sectionPlan 边界诊断（第一阶段）

章节目标报告追加 `targeting.targets[].sectionPlan`：包含 `sourceRange`、`expectedBlocks`、`status=ready/unavailable`、`reason`，起止 owner 的标签、class、DOM 路径和 metadata 标题行摘要，以及 `startHeading`、`endHeading` 的 DOM 标题存在、文本匹配、层级匹配、唯一性和 `orderPassed` 诊断。新增 `sectionDomRange`（同父容器、起点含／终点不含的 DOM 路径及节点数量）、`boundaryEvidence`（标题唯一、文本、级别、顺序与连续区间证明）和 `contentNodesUnchecked`（尚未验证内容覆盖的节点摘要）。DOM 节点只在内部保留，不写入 JSON。

标题边界由当前阅读视图的 H1～H6 节点与现有 metadata 标题行绑定，不要求标题自身有正文式 LayoutContext。起止及章节内标题必须在源码和 DOM 中同级同名唯一，顺序一致；边界 owner 必须在同父容器中形成连续区间，正文在 sectionPlan 阶段不要求源码映射；已有可信映射仅用于拒绝跨章节容器或明显顺序矛盾。`ready` 只表示标题界定的 DOM 连续区间已建立。unknown、unsupported 和 expected blocks 仍需内容覆盖核验；ready 章节不再以源码定位精度作为独立阻断条件。标题文本、级别、唯一性或顺序无法确认时返回 unavailable。没有下一同级或更高层级标题的末章暂不支持 document-end；复杂嵌套 owner 或无法证明连续性的结构同样保守 unavailable。

逐屏 observe 保存标题标签、文本、级别、屏内 DOM 顺序及扫描状态，并保存当屏连接节点形成的边界验证快照。报告优先使用扫描期间快照；startHeading/endHeading 的 headingDuringScanFound 与 headingAfterScanFound 区分扫描时和恢复滚动后的匹配情况。headingSnapshots 为纯数据诊断，不保留 DOM 引用。跨屏标题仅曾出现而没有连续边界证明时仍 unavailable；观察到重复、层级或顺序冲突时拒绝 ready。这些历史快照不证明当前 DOM 边界稳定，也不代表测量覆盖通过。诊断异常仅返回 unavailable；不参与扫描选择或短尾测量。ready 时 coverage 可使用扫描期间对 gap 原始 DOM 身份的章节内外归属证据；明确目标外 gap 记入 ignoredOutsideSectionGaps，目标内 gap 记入 checkedInsideSectionGaps，并按实际 DOM 检测证据验收。无法归属的 gap 保留旧规则；unavailable 完全沿用旧 coverage 规则。expected blocks、未支持内容与测量检查不变。仍只有现有 visible/full 扫描，没有 section scan。本轮开发验证：目标扫描 58/58（含扫描后标题移除与后续重复标题拒绝）、Callout 74/74、章节解析／请求协议／存储／命令 88/88、CLI 15/15、原短尾回归及手动布局 5/5 通过。合成浏览器和 API 替身测试不能代替真实 Obsidian 的 DOM 与布局验证；该轮只完成开发树中的合成验证。后续真实 Obsidian Beta 结果见本节顶部，验证范围限于列出的测试案例。

本轮标题边界优先调整验证：目标扫描 62/62、章节解析／请求协议／存储／命令 88/88、原短尾回归通过；语法与 diff 检查通过。新增用例确认正文映射缺失时边界可 ready 而 coverage 仍 uncovered，跨章节容器、后续跨章节冲突、插入同级标题及重复标题仍失败。该轮记录的是当时的离线开发验证；后续真实 Obsidian Beta 结果见本节顶部。

本轮 sectionPlan 与 coverage 集成验证：目标扫描 65/65、Callout 74/74、章节解析／请求协议／存储／命令 88/88，以及语法与 diff 检查通过。覆盖目标外 null gap 排除、目标内 null gap 阻断和 unavailable 保持旧行为。该轮仅验证开发源码和合成场景，没有真实扫描；后续真实 Obsidian Beta 结果见本节顶部。

ready 章节采用 DOM 内容验收：使用扫描期间的节点身份关联原测量结果，并核对章节渲染结构。没有相关 mapping gap 时，按 expected blocks 的类型、顺序和数量检查缺失；存在相关 gap 时，源码映射缺口只降低 `mappingPrecision` 为 `partial`，不单独阻断 target coverage，依据章节内成功测量结果继续判定。没有任何成功测量 blocks、unsupported 和明确渲染异常仍返回 uncovered。边界 unavailable 保持原源码覆盖规则。内部测量节点引用不可枚举，不写入报告，全文测量和 documentCoverage 不变。

本轮渲染优先验收验证：目标扫描 69/69、Callout 74/74、章节解析／请求协议／存储／命令 88/88、原全文回归通过，语法与 diff 检查通过。新增 partial 映射通过、无行号测量保留、expected block 缺失、未测文本失败和 unavailable 保持旧逻辑的用例。该轮只做合成验证，没有真实扫描；后续 Beta 仅验证本节顶部列出的案例。

章节覆盖调整：可信 `sectionPlan` 已就绪且章节有实际测量 blocks 时，源码 mapping gap 只降低 `mappingPrecision` 为 `partial`，不单独阻断 `targetCoverage`。章节没有任何成功测量、存在 unsupported 内容或明确渲染异常时仍为 uncovered；`sectionPlan=unavailable` 沿用旧覆盖判断。该轮目标扫描测试 71 项通过，未包含真实 Obsidian 扫描；后续 Beta 归档验证了本节顶部列出的章节。

CLI 验收同步：带 mapping gap 的 complete 章节报告必须同时具备 ready sectionPlan、partial 精度、成功测量和空 reasons；无 gap 的旧源码覆盖证明不强制要求 ready sectionPlan。request/response/archive 身份、源码和 documentCoverage 校验保留。章节调用端 25 项和原 CLI 15 项离线测试通过。

## 手动使用

打开笔记的阅读视图，在命令面板选择：

- 短尾行检测原型：检测当前阅读视图短尾行
- 短尾行检测原型：检测并导出当前阅读视图报告
- 短尾行检测原型：检测整篇阅读视图短尾行
- 短尾行检测原型：扫描整篇阅读视图并导出报告

四种手动命令均要求当前笔记为阅读视图，扫描前记录原视图、文件、侧栏状态和滚动位置，临时收起左右侧栏并等待布局稳定。“当前可视”指收栏后稳定的视口。进行可重复验收时，应记录并保持一致的布局参数。扫描期间保持笔记与宽度不变。

成功、扫描错误、保存失败后均独立尝试恢复两侧栏，再等待布局稳定并恢复原视图的滚动位置；等待中切换笔记或视图时不将旧位置应用到新视图。恢复成功后才显示结果窗口；恢复失败单独提示，并保留原错误，已保存报告仍明确标为已保存。公开取消命令已移除，插件卸载取消及扫描内部的文件、模式、宽度变化防护保留。手动与 Codex 请求共享侧栏操作，核心测量和归档策略不变。

两项“检测…短尾行”命令只显示结果，不自动保存 JSON；结果窗口仍可手动导出。两项带“导出”的命令会自动保存。“当前”命令扫描可见区域一次，“整篇”命令复用全文逐屏扫描并在结束后恢复原滚动位置。

## Codex 本地调用

安装目录中的脚本可通过以下占位示例调用；请将 `<vault>` 和笔记相对路径替换为实际值：

```bash
python3 -B "<vault>/.obsidian/plugins/short-tail-inspector/scan-note.py" "测试/短尾行检测测试.md" --vault "<vault>"
```

`--vault` 为必填参数。插件在处理请求时检查目标笔记是否唯一打开，并在 Obsidian 内读取阅读视图的实际内容区宽度和字号；调用方无需通过界面预检或截图。CLI 请求带有预期布局值，默认校验值为内容区 700px、正文 16px；仅当使用其他可信预期值时才传入 `--width` 和 `--font-size`。实际布局不匹配时插件返回错误，不会更改 CSS。

插件会临时切换阅读模式、收起两侧栏，等待布局稳定，检测后恢复原模式与侧栏；全过程可能短暂滚动笔记。错误基准会被拒绝，不会自动修改字号或 CSS。

脚本自动填写源文件校验值与请求有效期。过期请求、错误源版本、笔记未打开、宽度变化及覆盖不完整会返回错误或不完整状态。

请求、响应和最新结果写入本插件目录的 `request.json`、`response.json`、`report.json`。每次经保存入口导出的报告另存于 `reports/`，包括全文、局部和 incomplete 结果；同一结果窗口再次导出产生独立保存身份，不覆盖前次归档。成功保存的可信归档达到 20 份后清理到最新 5 份，旧版归属不明报告保留。报告是临时检测记录，不是知识笔记备份。请求入口每 500ms 检查自己的请求文件；关闭插件即停止。

调用方应先检查响应 id 和状态，再读取本轮 archivePath；共享的 report.json 可能已被后续保存替换。报告 requestId、file、sourceSha256 必须与本次请求一致，脚本会核对归档身份。旧请求的 `complete` 只表示支持范围的全文源区块覆盖核对完成，不代表没有疑似短尾或内容准确性已经通过。文件入口是单请求邮箱，调用方须串行发起请求；多个 CLI 同时覆盖 request.json 不受支持。

建议执行顺序：读取目标笔记 → 发起检测 → 阅读疑似位置与源码 → 在授权范围内修改 → 重新发起检测 → 核对同一源位置的结果。不根据旧报告验收新版本。

这是本地文件请求协议，可由脚本或其他本地调用方使用；不是已注册的 MCP 服务。

### v0.2.2 配套调用端：Codex 自动章节定位

用户只需说“扫描这篇笔记第4章”。Codex 按 [CODEX-WORKFLOW.md](CODEX-WORKFLOW.md) 自行读取真实 Markdown，处理祖先标题、重复标题、围栏、Setext、frontmatter 和章节边界，再使用已有 `--target` 完整 headingPath 发起请求，不要求用户手填路径或行号。无法消歧时询问章节含义；复杂 Markdown 无法可靠定位时明确停止。

新增可选 `--expected-source-sha256`（绑定定位时源码版本）、`--expected-section-range START:END`（比对插件实际解析范围）及 `--include-request`（输出原始请求/响应）。章节范围保护要求前者和一个不含显式行号的 section 目标。身份、目标、范围、源码版本和目标完整覆盖全部通过后，调用端 `sectionAcceptance.coverage` 才为 `covered`；插件原始 `complete/uncovered` 枚举保持不变。全文 fallback 单独 complete 不能算章节成功。

调用端改进没有引入新解析器或依赖，manifest 版本仍为 0.2.2。旧 CLI 参数、默认响应输出及协议保持兼容，部署不会随源码修改自动发生；每次验收应以安装目录 manifest 和本次归档的 pluginVersion 为准。新增离线入口为 `python3 -B tests/chapter-workflow-test.py` 和 `node --test tests/chapter-targets.cjs`；测试范围与真实应用验证限制见工作流文档。

调用端初轮离线验证（覆盖修复前）：新增调用端验收 19/19、原 CLI 15/15、章节解析 12/12、请求协议 16/16，共 62 项通过，Python AST 与 git diff --check 通过。实现前新增保护用例先确认旧 CLI 缺少参数；补充 CRLF 测试时原先“ATX 可解析”的期望失败，实证原始 CRLF 的 ATX/Setext 均被现有校验拒绝，已修正测试与限制说明，未改核心算法。该轮仅完成离线检查，没有真实 Obsidian 扫描或部署。后续 Beta 已验证本节顶部列出的真实章节；任意自然语言消歧、CRLF 以及未列出的 metadata/DOM 结构仍不能据此视为通过。

### v0.2.2 开发记录：Callout 与纯分隔线覆盖

`target-scan.js` 接受 Obsidian 原生 `type=callout` 作为可测文本容器。当前完整覆盖证明限于普通引用段落：源码标记及范围、唯一容器、逐段文本与顺序、每个非空白字符的渲染几何、可信源码版本/归属和成功测量必须同时成立。任何段落缺失、隐藏字符、裁切、折叠、嵌入、未测容器文本、生成内容或可见标题均不能验收 complete。隐藏的默认/自定义标题不承担正文测量义务；可见标题暂不新增测量算法，明确返回 uncovered。列表、代码、行内 Markdown 等复杂正文仍可返回测量候选，但在尚无完整映射证明时保守 uncovered；此限制适用于所有 Callout 类型，不依赖 K 或特定测试笔记。

仅 `type=thematicBreak` 与当前源码一致、单行纯 `***` / `---` / `___`（含合法空格）、不在 frontmatter/围栏内、无重叠 metadata、无 Setext 歧义时，免除文本映射义务。实例化分隔线旁出现意外渲染文本仍阻止覆盖。报告的 `targeting.targets[].expected` 保留原行号和类型，并追加 `textCoverage=excluded`、`exclusionReason`、`sourceText`，由报告原有 `file/sourceSha256` 绑定源码版本。目标章节范围不变；目标内 unsupported、缺失文本区块和未知映射不豁免。仅含分隔线而没有可测文本的目标仍为 uncovered；全文回退的覆盖状态另行报告，不直接阻断已完整覆盖的目标。

定位、扫描观察、结果筛选使用同一分类与覆盖规则；未改动 `main.js` 的字符测量、全文遍历或请求/保存协议。新增离线入口 `node tests/callout-coverage.cjs` 使用与原浏览器回归相同的依赖参数、合成源码/metadata/DOM 和真实字符几何，不连接 Vault 或 Obsidian。这些实现属于 0.2.2 开发范围。离线测试通过不代表所有 Callout、主题与 metadata/DOM 组合都已由真实 Obsidian 验证；本次 Beta 案例只验证了其中记录的具体结构。

目标覆盖的未知节点归属只使用可信父容器或未知节点两侧的源码锚点：其他位置同侧锚点乱序不再使缺口全局化；两侧源码交叉或重叠仍按无法定位处理。没有源码空隙的意外节点保守归属于两侧区块，触及目标边界仍阻断。只有缺口范围能证明与目标不相交时，才不影响目标 coverage；全文 `documentCoverage`、章节定位和字符测量不变。

unknown 缺口按 DOM 节点及文本状态跟踪，报告追加 `state=pending/located`，节点身份仅在内存保留。早期无范围缺口在后续观察中使用已有可信映射与锚点重新归属；只在原节点、文本及整个祖先链的父节点和相邻节点未变且仍在同一阅读容器时更新历史缺口。目标外可信范围解除目标阻断；目标内、最终无法归属、已脱离 DOM 或位置变化的历史缺口继续阻断。全文诊断保持原逻辑。

仅当 `mappingGaps[].possibleRange` 为 `null` 时，targeting 诊断会追加节点 tag/class、父节点 tag/class、最多 160 字符的 `textContentSummary`、`fromHrBranch` 和可取得的 `sourceContainerRange`。这些字段只用于定位映射缺口，不参与 coverage 判定或短尾测量；文本摘要可能包含笔记原文。

伪元素覆盖判定后续开发修复：仅在祖先 `display:none`、伪元素自身不显示/隐藏，或可靠解码的单个 CSS 字符串只含 CSS 空白及 U+200B 零宽排版占位时，免除生成文本义务。此规则不免除隐藏、缺失或裁切正文的原覆盖检查；不按 icon/fold 类名普遍豁免，也不以零宽盒子证明没有可见文字。非占位字符串及无法分类的计数器、URL、混合内容等继续 uncovered，报告 `targets[].reasons` 记录源范围、Callout 内节点路径、伪元素、原始计算 content 和阻断原因。这些字段表示未测义务，不能仅据 content 断言实际可见。隐藏标题仍不测量；可见标题继续阻断。该规则有离线回归覆盖；本次 Beta 案例没有专门验证伪元素相关场景。

伪元素修复离线验证（2026-10-10）：扩展 Callout 检查 67/67（新增 23 项）、既有目标扫描 28/28、布局恢复 5/5、原测量回归脚本、Node 章节/协议/保存/命令 87/87、Python 调用端/CLI 34/34 全部通过。夹具包含图标 SVG、折叠控件及内置样式同类 U+200B 伪元素；修复前先复现隐藏图标误判。覆盖纯占位/隐藏子树、可见图标文字、自定义标题、计数器/URL/混合内容、零宽溢出、裁切、生成内容在局部定位后出现、双目标及全文 complete 无法掩盖漏测。初次无头浏览器启动被沙箱终止，使用获准的独立无头临时配置运行；未连接正式 Vault 或真实 Obsidian，离线通过不代表已解决真实应用的全部覆盖问题。

覆盖修复离线验证（2026-10-10）：新增覆盖检查 44/44、原目标扫描 28/28、布局恢复 5/5、原测量回归脚本通过；Node 章节/协议/保存/命令 87/87、Python 调用端/CLI 34/34，语法与 `git diff --check` 通过。新增检查覆盖原生 Callout metadata、真实正文短尾测量、标题可见性、缺节点/错文本/折叠/裁切/嵌入/隐藏字符/生成内容、源码版本或映射丢失、纯分隔线/伪分隔线、双目标和全文/局部覆盖。初轮浏览器被沙箱终止，获准使用独立无头临时配置后运行；段落核对中“DOM 自带分隔空格”的错误假设及缺映射测试替身问题修正后，最终无失败。使用已有 Playwright 与 Chrome，未下载依赖、部署或运行真实扫描。

### v0.2.2 开发中：完整视觉段落验收（未纳入已验收能力）

定位片段与测量对象分开：用户口述开头或粘贴几句，Codex 从当前 Markdown 和上下文恢复完整段落；歧义不能选第一处。新增报告 `blocks[].measurementUnit` 标记独立正文 `<p>`、紧凑列表自身文本或代码块。正文身份保留完整节点文本（`<br>` 为换行），并记录字符几何、隐藏/内部裁切、未知生成内容及连续性证明；已有 key/domPath/源范围复用，不创建永久节点 ID。完整测量仍使用原字符几何算法和实际宽度，不按源码物理行拆段，不合并不同 `<p>`。

新增可选 `--select-paragraph` 严格验收：一个附完整原始源码 text 的 lines 容器目标，加 `--expected-source-sha256` 与 `--include-request`。CLI 校验源码前后版本、三方身份、精确解析范围、resolved、源区块完整包含、扫描方式和目标完整覆盖，再要求完整渲染文本精确对应唯一且证据完整的正文节点。`paragraphAcceptance` 单独输出容器覆盖、所选块及该段疑似状态；原请求、响应、归档及容器统计保持原值。范围相交或片段命中不等于段落 covered，全文遍历完成也不能代替覆盖。旧调用保持兼容，缺少新版节点证据的旧归档在严格模式拒绝。

第一阶段允许完整容器中的相邻段落被测量，只对指定完整段落给出选择结果；不提供真正的只测单节点协议，不做模糊搜索或 Markdown 解析器。紧凑 `<li>` 与代码不作为正文 `<p>` 选择。列表内 Callout 现在仅在唯一可信 `list` metadata 范围、单个平面列表 DOM、源码列表项与直接 `<li>` 数量一致，且每个完全引用的 Callout 子范围能与同一列表项的 Callout DOM 按源顺序一一对应时，才沿用原 Callout 全文检查；缺失、重复映射、嵌套列表或复杂源码继续 fail closed。该受限映射仍须在独立测试 Vault 实测。真实复制文本和软/硬换行表示也待实测；无法判定完整文本时停止。调用及验收见 [CODEX-WORKFLOW.md](CODEX-WORKFLOW.md)。新增入口：`python3 -B tests/paragraph-workflow-test.py`、`node tests/paragraph-units.cjs`（同现有 Playwright/Chrome 配置）。

2026-10-10 离线验证：段落节点 37 项、严格 CLI 14 个测试通过；既有章节/协议/归档/命令 Node 87 项、Python 章节 19 项和 CLI 15 项、目标扫描 28 项、Callout 67 项、布局 5 项及原布局回归通过。均为合成源码、元数据和 DOM/邮箱，不能代替 Obsidian 实测。

### 0.2.2 定位扫描

不提供目标参数时，脚本继续发送 schemaVersion 1，插件仍执行原全文扫描。提供目标时发送 schemaVersion 2，旧插件会拒绝此版本，不会静默忽略目标。示例仅使用占位路径：

```bash
python3 "<插件目录>/scan-note.py" "目录/笔记.md" --vault "<vault>" --lines 42:46
python3 "<插件目录>/scan-note.py" "目录/笔记.md" --vault "<vault>" --section "章节标题"
python3 "<插件目录>/scan-note.py" "目录/笔记.md" --vault "<vault>" --paragraph "精确的段落源码"
python3 "<插件目录>/scan-note.py" "目录/笔记.md" --vault "<vault>" --target '{"kind":"paragraph","startLine":42,"endLine":46,"headingPath":["章","节"]}'
```

参数均可重复；每个参数产生一个目标，多处修改即使相邻或在同一屏也执行全文扫描。`--section` 指定顶层标题，嵌套标题通过 `--target` 的 headingPath 数组指定；`--paragraph` 精确匹配段落源码，重复文本不能靠第一个命中消歧，建议提供源码范围。

新请求保留旧请求的 id、action、file、expectedSourceSha256、expectedLayout、temporaryReadingLayout、expiresAt，增加非空 targets 数组，最多 100 个目标：

```json
{
  "schemaVersion": 2,
  "targets": [
    {"kind": "lines", "startLine": 42, "endLine": 46},
    {"kind": "section", "headingPath": ["章", "节"]},
    {"kind": "paragraph", "text": "精确的段落源码"}
  ]
}
```

上例仅展示新增字段，并不是可直接发送的完整请求。section、paragraph、lines 均可提供 startLine/endLine，采用当前源码版本的 1-based 闭区间；可附 headingPath 或 text 校验上下文。行号越界、倒序、非法类型会在改变布局前拒绝。

请求处理期间由插件检查唯一匹配的目标笔记、暂时收起两侧栏并切换到阅读视图，再使用实际渲染上下文定位；调用方无需操作界面。仅单目标对应的全部测量块都可信、无未支持内容且完整位于一个视口内时，才使用现有不滚动局部扫描。定位可以先滚动一次；扫描阶段不滚动。多目标、超屏、DOM 未实例化、旧映射或映射不可靠均直接复用原全文逐屏扫描，不增加探测式滚动算法。

筛选粒度为完整源区块，不宣称任意源码行或字符精度。修改一行仍可能需要测量整个段落或代码块；局部源码范围不能唯一对应区块内多个段落时，全文回退返回候选区块并标记 uncovered。重复标题或段落返回全部候选范围并标记 uncovered；完全缺失时结果可以为空，但不能报 clear。表格、嵌入、折叠内容、图形、裁切内容和测量失败不算目标已覆盖。简单标题利用 Obsidian metadata headings，校验所有祖先标题与源码 ATX/Setext 层级；章节内及边界标题缓存不一致时不能可信定位。复杂标题或缓存无法与源码核对时保守回退。

普通文本缺少可信源码映射时也不能忽略：定位阶段全文回退，扫描中失去映射或渲染版本证据则返回 uncovered。无法确认这类文本是否位于目标之外时，同样保守判定 uncovered；不会通过筛掉无位置文本来得到 clear。

目标报告使用 schemaVersion 3，保留原 scan 字段，增加 targeting；原 scan.complete 仍只表示全文覆盖，局部扫描不会将它设为 true。新响应使用 schemaVersion 2，保留原路径和统计字段，并增加：

| 字段 | 含义 |
|---|---|
| completionScope | targets，完成结论针对指定目标 |
| scanMethod | visible 或 full，区分局部与全文回退 |
| documentCoverage | complete、incomplete 或 not-scanned；保留全文覆盖结论，局部扫描不验收全文 |
| targetCoverage | complete 或 uncovered |
| targetResult | clear、suspected、uncovered；错误时 failed |
| targets | 解析范围、每个目标的覆盖、原因和疑似统计 |
| errorPhase | request、layout、scan、save 或 restore |
| scanSucceeded / scanTargetResult | 保存失败时仍区分已完成的扫描与失败阶段 |
| cleanup | 清理是否触发、删除数量和警告；不改变有效扫描结论 |

只有目标完整覆盖才返回 complete/clear 或 complete/suspected；允许 documentCoverage=incomplete 同时 targetCoverage=complete。全文的 scan.complete、missingSourceLocations 和 uncoveredSections 保持原义。目标判定使用 expected 源区块、唯一可信 DOM 归属、成功测量、未支持内容及相关映射缺口，不直接继承全文失败标志。扫描异常返回 error/failed；保存失败不触发清理；恢复失败返回 error 并保留已有报告路径及恢复错误。脚本退出 0 表示目标覆盖完成，不表示疑似数量为零。源文件、模式或视口宽度变化时停止扫描；文件请求在导出前还核对正文宽度及字号未改变。完成、取消和失败后均尝试恢复原模式、侧栏和定位前位置。

新增 targeting.coverageBasis=target-source-blocks-v1 标记目标独立判定。每个目标的 mappingGaps 记录相关未知内容的 kind（text/unsupported）和 possibleRange；该范围是可能归属区间，不是成功源码映射，null 表示无法确定。只有同文件、同源码版本的可信父容器，或阅读 DOM 中按源码顺序排列且不重叠的可信渲染容器边界，才能将未知内容排除在目标之外。目标内或无法排除属于目标的未知内容仍阻断覆盖；跨界、缺失 expected、测量失败、折叠和裁切等原有检查继续生效。CLI 核对新标记、目标证据和 documentCoverage 一致性；无此标记的旧报告仍按原全文回退验收规则处理。

该组记录描述当时的离线开发验证，不代表当前安装状态。后续真实 Obsidian Beta 已验证本节顶部列出的三个章节；存在 mapping gap、复杂 Callout 和其他未列出的渲染结构仍应按各自报告结果判断。

schema2 脚本核对归档内每个 requested 目标与请求一致、响应 targets 与归档一致，以及 targetResult、覆盖和任务状态一致；complete 要求每个目标完整覆盖。缺字段或矛盾结果拒绝验收，schema1 保持原校验行为。保存与布局恢复同时失败时，任务仍为 error/failed，scanTargetResult 保留已完成扫描的原结果。

## 验证记录

- 0.1.1 逐项测试与主动断行误报修正：test-results.json
- 0.2.0 实际整篇测试：full-scan-verification.json。50 个源区块、32 个文本块；原有样本结果一致；长注释的第 3 个源码行自动换行后末行“换行”被识别；正常独立代码行和 6 条紧凑列表不误报
- 本地入口：在侧栏打开时，临时收起侧栏按历史验证配置 700px / 16px 完成扫描，再恢复侧栏；错误宽度与错误源校验值均被拒绝
- 独立浏览器额外验证：相同文字的 20 个段落不被合并，重复扫描稳定；取消、宽度变化保护、滚动恢复、代码注释不作为章节标题，以及旧渲染源版本不确认覆盖

测试笔记第 6 章使用中性标题“代码块检测测试”。样本核对代码块源码行的自动视觉换行检测，以及源码主动换行不误报；第 8 章区分仅扫描当前可视区域的命令与逐屏扫描全文的命令，两者覆盖范围不同。

## 未覆盖与限制

- 表格单元格、嵌入笔记、图片、Mermaid 等图形没有完整检测
- 折叠 Callout 内部内容不会自动展开，应检查跳过列表
- 复杂字体、上下标和双向文字等仍需进一步验证
- 每次全文扫描先通过公开的 previewMode.rerender(true) 刷新全文，并核对阅读内容与源文件一致。若刷新后仍缺少位置，返回 incomplete；停止继续改写，不要求通过界面点击反复补救。同步未完成时返回错误，应等待后重试
- 当前是检测原型，不会自动改写文字；Codex 仍需判断技术含义和可接受的排版例外

## 0.2.1 复检流程

全文扫描会先刷新渲染，保留滚动位置，不修改源笔记。调用方必须等待 complete 后再据报告修改；复检 incomplete 时不能继续以疑似数量为依据精简文字。每轮保留独立报告，逐项修改前后对照仍由调用方记录；本版本没有自动判断某处语义是否相同。

## 开发工程与安装副本

本仓库是权威开发源码，保存运行文件、测试、夹具与验证资料。Obsidian 安装副本位于 `<vault>/.obsidian/plugins/short-tail-inspector/`；`<vault>` 表示用户知识库根目录。0.2.2 运行文件为 `main.js`、`report-store.js`、`target-scan.js`、`manifest.json`、`scan-note.py`，main.js 使用桌面适配器的库根路径及 manifest.dir 按绝对路径加载两个相邻模块，不依赖工作目录。知识库 CSS、笔记和排版规则由用户维护。

更新关系为开发源码 → 验证后安装副本 → Obsidian 加载。当前没有自动构建或部署流程。部署须另行授权，仅更新明确的发布文件；保护 `request.json`、`response.json`、`report.json` 和 `reports/` 等运行数据。更新后核对文件一致性并重新加载确认实际版本，单独核对插件启用状态，不擅自修改 `community-plugins.json`。开发规则见根目录 `AGENTS.md`。

## 可重复回归测试

入口为开发目录的 `tests/regression.cjs`，从 0.2.1 的临时测试保护而来。默认读取相对位置 `../main.js`，也可通过第一个参数指定源码。HTML 样本内嵌，无临时目录依赖；不连接真实 Obsidian，不写笔记、报告或插件运行数据。

需要 Node.js、Playwright 和可用的 Chromium 浏览器。Playwright 默认按 Node 模块解析；可用 PLAYWRIGHT_MODULE 指定已安装模块路径。CHROME_EXECUTABLE 可指定本机 Chrome；不指定则使用 Playwright 已安装的 Chromium。测试不会下载依赖或浏览器。

在开发目录运行（依赖已可解析时）：

```bash
node tests/regression.cjs
```

如需指定已有宿主依赖，替换以下占位路径；无须使用特定操作系统或缓存目录：

```bash
PLAYWRIGHT_MODULE="<playwright-module-path>" CHROME_EXECUTABLE="<chromium-executable-path>" node tests/regression.cjs
```

覆盖主动断行、短尾识别、紧凑及嵌套列表、独立代码行、较早源码行的折行、同文不同位置的 20 个段落、重复扫描、取消、宽度变化、滚动恢复、代码注释标题排除和旧渲染版本拒绝。断言失败时退出非零。Obsidian 的渲染上下文、重新渲染接口和 SHA-256 在该测试中使用替身，因此它不能独立证明真实 Obsidian 的刷新、文件同步或侧栏恢复；这些能力需真实应用验证。

`tests/fixtures/short-tail-layout.md` 是人工构造的插件测试样本，含正文、自定义 `[!K]` Callout、代码、引用与列表对照。它不由 regression.cjs 自动加载，可用于另行授权的真实 Obsidian 测试。frontmatter 的 `linux-notes` 是历史验证环境使用的自定义 CSS 类，仓库未包含其样式；使用其他主题时应核对实际渲染，不能期待相同像素结果。

## 0.2.1 已完成验证

`repair-verification.json` 保留历史真实应用验证的去内容化摘要：149 个源区块覆盖完整、108 个文本块、疑似 0、跳过 10 张表格；源笔记未改变，重复扫描同样 complete。`verification.json` 保留同一文本在两种宽度下换行变化的历史统计。两份摘要均已去除源笔记内容、路径、文件校验值和报告标识，不是可重新执行的测试或合成 fixture 的新测量结果。

现有回归测试此前已成功执行。真实应用结果仅适用于对应布局和文件版本，不保证所有复杂笔记均通过；公开摘要不能独立重现这些测量。经删减的旧样本历史记录保留在 `test-results.json`、`full-scan-verification.json` 和 `integration-verification.json` 中。

## 0.2.2 保存与历史清理

所有保存入口（含同一结果窗口再次导出）共享同一 Obsidian 进程内按插件目录串行的 Promise 队列。每次保存生成独立 UUID，复制报告并预先填写 archivePath 和 storage。暂存归档与最新报告采用相同 JSON；写入及读回一致后，使用不覆盖已有文件的原子硬链接提交归档。提交前的 .pending 文件不计数、不清理。没有持久索引、锁文件或定时任务。

正式归档名为 `sti-v1-<13位保存顺序>-<UUID>.json`；内部 storage 记录生成者、格式、保存身份、顺序及内容摘要。清理同时验证文件名、路径、内部身份、摘要和普通文件属性，不能只靠扩展名或 pluginVersion 判定归属。按成功保存顺序排序，重复导出晚保存的旧扫描结果也属于新保存；同毫秒保存及本进程时钟回拨不会按 capturedAt 错序。

- 所有成功保存的全文、局部、incomplete、重复导出一视同仁；可信归档数量达到或超过 20 时，删除旧报告到最新 5 份。没有完整全文优先级，不按笔记分组、不按疑似数量排序。
- 保存失败不清理。新版本暂存文件、旧版无法确认归属的归档、人工文件、未知或被修改的报告、目录和符号链接均保留，不纳入可清理计数。
- 清理仅涉及 reports 内通过验证的正式归档。request.json、response.json、report.json、笔记和安装文件不属于清理对象。
- 删除前重新验证路径、文件身份和内容；发生变化或删除失败时保留并报告警告，实际文件数可能超过 5，不能为了凑数扩大删除范围。
- 归档或最新报告部分写入失败时，可能保留暂存文件或已更新的最新报告，但不会提交本次可计数归档或触发清理。新成功报告的归档与最新报告在提交时内容一致；后续保存可更新最新报告。

安全保存要求桌面 FileSystemAdapter.getBasePath() 和支持硬链接的文件系统；不满足时明确保存失败并保留历史。读回验证不是断电耐久性保证。队列保护本 Obsidian 进程内的保存并发，不支持多个 Obsidian 进程同时管理同一 Vault；没有引入跨进程锁，外部同步或编辑报告也不属于受队列保护的写入。归属摘要用于识别损坏或改动，不是对恶意伪造者的身份认证。

脚本报告仍使用源区块位置与 DOM 路径，不具备跨结构变更的自动逐项匹配；修改前后对照及语义判断仍由调用者完成。

## 0.2.2 开发验证与待验证项

新增测试可从仓库根目录运行，不连接真实 Obsidian：

```bash
node --test tests/report-store.cjs tests/request-protocol.cjs
node --test tests/commands.cjs
python3 -B tests/scan-note-test.py
node tests/target-scan.cjs
node tests/manual-layout.cjs
```

target-scan.cjs、manual-layout.cjs 与原 regression.cjs 使用相同 PLAYWRIGHT_MODULE / CHROME_EXECUTABLE 配置。保存测试只操作临时目录；CLI 测试使用临时合成邮箱；请求测试使用 API 替身；浏览器测试使用合成 HTML 和真实字符/元素几何，无截图、录屏或屏幕共享。不会更新历史验证 JSON。

覆盖 19→20→5、混合报告、重复导出、并发保存、写入/读回/提交/删除故障、链接与旧文件保护、时钟回拨、旧请求全文、新请求状态、恢复失败、CLI 归档身份，以及局部定位、全文回退、重复段落、超屏、未支持和裁切目标。

初轮开发验证：保存和请求测试 24/24 通过，CLI 测试 8/8 通过，目标浏览器检查 22/22 通过，原 regression.cjs 通过；JavaScript/Python 语法及 git diff --check 通过。浏览器在默认沙箱中首次启动失败，获准独立无头运行后通过；首轮删除故障注入因 macOS 临时路径别名导致一项断言失败，修正测试路径后通过。

独立复核后的四项修复新增回归：部分文本映射不可信时全文回退、局部扫描中映射/版本证据丢失时 uncovered、过期祖先路径和标题层级拒绝、schema2 目标及结果一致性、保存和恢复叠加失败保留扫描结果。新增断言先复现旧实现失败，再验证修复。最终保存和请求测试 25/25、CLI 测试 15/15、目标浏览器检查 28/28、原 regression.cjs 均通过；7 个 JavaScript 文件语法、2 个 Python 文件 AST、git diff --check 通过。浏览器仅使用独立无头临时配置，无截图或真实 Vault 操作。

2026-10-11 的 Beta 归档确认三个指定章节在真实 Obsidian 阅读视图中得到完整目标覆盖，并通过 request、response、archive 返回结果。该证据不等于对任意笔记、所有 metadata/DOM 组合、伪元素、侧栏恢复和各类布局的全面认证；未覆盖的具体结构仍需单独验证。合成浏览器和 API 替身测试不能代替这些真实应用场景。

新增“检测整篇阅读视图短尾行”命令的测试 4/4 通过，覆盖不自动保存、结果窗口手动导出、原命令行为和扫描失败；请求协议测试 14/14 通过，JavaScript 语法与 git diff --check 通过。本轮原 regression.cjs 在 width guard failed 断言失败：测试通过 applyScroll 安排延迟宽度变化，而全文刷新也会调用 applyScroll，变化可能发生在扫描宽度基准建立前；本轮未修改此测试或扫描算法，也不将该回归记录为通过。该轮没有验证命令窗口显示、全文命令、手动导出或最终滚动位置；Beta 章节请求不能替代这些特定场景的验收。

随后仅修复 regression.cjs 的宽度测试时序：在现有 observe 回调确认首屏已按 360px 测量后同步改为 300px，核对实际宽度变化，并分别断言宽度错误与滚动恢复，不再依赖 70ms 定时器。修复后浏览器回归脚本 1/1 通过，命令测试 4/4、请求协议测试 14/14 通过，测试脚本语法与 git diff --check 通过；产品代码与版本未变，真实 Obsidian 验证状态未变。

手动收栏与移除公开取消入口后的开发验证：命令及布局恢复测试 47/47、请求协议测试 16/16 通过，覆盖四种扫描与四种侧栏组合、部分收栏失败、扫描/保存/恢复失败、内部卸载取消，以及准备、扫描、恢复等待期间的文件/视图切换。manual-layout.cjs 的 5/5 合成浏览器检查通过：四种命令在侧栏动画稳定后按收栏宽度测量、滚动与布局恢复，以及真正扫描中的宽度变化仍停止检测且不保存。原 regression.cjs 1/1 通过，4 个 JavaScript 文件语法及 git diff --check 通过。该轮测试未覆盖真实 Obsidian 的侧栏动画和最终滚动位置；其合成测试结果仅适用于所列场景。Beta 章节请求成功不代表这些交互已被独立验收。

本次 v0.2.2 收尾核验：commands.cjs 48/48、request-protocol.cjs 16/16、report-store.cjs 11/11、Python CLI 15/15，共 90 项通过。用户确认已在隔离测试 Vault 人工验证，并在正式 Vault 安装 v0.2.2 后进行手动验证；这些人工验证不替代 Playwright 自动测试，本次收尾未重跑 Playwright。本次收尾核验没有使用 Computer Use 操作 Panel；后续 2026-10-11 Beta 归档确认 Codex Panel 发起的三个章节请求均有对应 response 与 archive。该结果只验证这些请求链路及案例，不代表所有 Panel 交互或扫描结构均已验收。此前各轮测试数字保留其当时的范围与限制。

## 公开样本清理与验证范围

行内代码 fixture 已替换为等长的人工合成文本。三份旧样本历史记录移除了受影响文本块及其测量，标记为不适用于当前 fixture；其余历史数据和原扫描统计保留，不能当作新样本验证结果。`tests/fixtures/inline-code-verification.json` 记录当前合成样本的真实浏览器测量及 fixture SHA-256，使用独立测试样式，不代表真实 Obsidian 或历史自定义 CSS 的测量；当前 fixture 的真实 Obsidian 复验待完成。

在仓库根目录运行 `node tests/verify-inline-fixture.cjs` 可重新生成上述浏览器测量记录；使用与现有回归测试相同的 Playwright/Chromium 依赖参数。该命令只更新开发目录内的验证 JSON。

## Panel 请求写权限

CLI 在插件的 `requests/` 专用目录写临时请求，再原子替换 `request.json`。调用方只需对这两个路径有写权限；响应、最新报告、归档及运行代码只读。暂存目录必须位于同一文件系统且不是符号链接；提交失败清理本次临时文件，不覆盖其他请求临时文件。仍要求串行调用。此目录不包含在部署包内，可由部署流程预建或 CLI 创建。
