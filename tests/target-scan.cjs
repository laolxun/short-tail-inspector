// Real browser geometry + existing scanner; Obsidian rendering APIs are substitutes.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<style>body{margin:8px}p{font:16px sans-serif;width:120px;line-height:24px;margin:12px 0}h2{font:18px sans-serif}pre{font:16px monospace}</style>');
    let scanner = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').split('class ResultModal')[0].split('\n').slice(1).join('\n');
    await page.addScriptTag({content: scanner + '\nwindow.scanner={sectionFor,elementPath,SELECTOR,settleLayout,refreshReading,inspect,LayoutContexts};'});
    await page.addScriptTag({content: '{const module={exports:{}};\n' + fs.readFileSync(path.join(__dirname, '../target-scan.js'), 'utf8') + '\nwindow.targetModule=module.exports;}'});
    const result = await page.evaluate(async () => {
      window.require = () => ({createHash: () => ({update() {return this;}, digest: () => 'fixture-hash'})});
      const checks = [], assert = (condition, message) => {if (!condition) throw new Error(message);};
      function fixture(options = {}) {
        document.querySelector('#fixture')?.remove();
        const container = document.createElement('div');container.id = 'fixture';document.body.append(container);
        const root = document.createElement('div');root.className = 'markdown-preview-view';
        root.style.cssText = `width:180px;height:${options.height || 180}px;overflow:auto`;container.append(root);
        const sections = [], contexts = new window.scanner.LayoutContexts(), lines = ['## 章节', ''];
        const heading = document.createElement('div');heading.innerHTML = '<h2>章节</h2>';root.append(heading);
        sections.push({type: 'heading', position: {start: {line: 0}, end: {line: 0}}});
        const rows = [], owners = [heading];
        for (let i = 0; i < (options.count || 12); i++) {
          const text = options.text?.(i) || `普通文本${i}`;
          const start = lines.length;lines.push(text, '');
          const owner = document.createElement('div');const p = document.createElement('p');p.textContent = text;owner.append(p);root.append(owner);
          rows.push({startLine: start + 1, endLine: start + 1, p, owner});owners.push(owner);
          sections.push({type: 'paragraph', position: {start: {line: start}, end: {line: start}}});
        }
        const source = lines.join('\n'), file = {path: 'fixture.md', stat: {mtime: 1}};
        owners.forEach((owner, i) => {
          const section = sections[i], info = {lineStart: section.position.start.line, lineEnd: section.position.end.line, text: source};
          contexts.set(owner, {ctx: {sourcePath: file.path, getSectionInfo: () => info}, info});
        });
        const cache = {sections, headings: [{heading: '章节', level: 2, position: {start: {line: 0}, end: {line: 0}}}]};
        const plugin = {contexts, cancelled: false, app: {vault: {read: async () => source}, metadataCache: {getFileCache: () => cache}}};
        const view = {containerEl: container, file, getMode: () => 'preview', previewMode: {get: () => source, getScroll: () => root.scrollTop, rerender() {}, applyScroll: n => {root.scrollTop = n;}}};
        const calls = [], hooks = {...window.scanner, inspect: async (...args) => {
          const before = root.scrollTop, report = await window.scanner.inspect(...args);
          calls.push({full: args[2], before, after: root.scrollTop});return report;
        }};
        return {root, rows, source, file, cache, contexts, plugin, view, hooks, calls};
      }
      const run = (f, targets) => window.targetModule.scanTargets(f.view, f.plugin, targets, f.source, f.hooks);
      const target = row => ({kind: 'paragraph', startLine: row.startLine, endLine: row.endLine});
      let f = fixture();f.root.scrollTop = 17;
      let r = await run(f, [target(f.rows[5])]);
      assert(r.targeting.scanMethod === 'visible' && r.targeting.result === 'clear', 'single reliable paragraph must scan locally and clear');
      assert(r.scan.full === false && r.scan.complete === false && r.scan.steps === 1, 'local result must not claim full coverage');
      assert(f.calls[0].before === f.calls[0].after && r.blocks.length === 1 && r.blocks[0].sourceStartLine === f.rows[5].startLine, 'local scan must not scroll or return nearby paragraphs');
      checks.push('singleTargetLocatedWithoutScanScrolling');

      f = fixture({text: i => i === 2 ? '测试'.repeat(7) + '测' : `普通文本${i}`});
      r = await run(f, [target(f.rows[2])]);
      assert(r.targeting.result === 'suspected' && r.blocks[0].suspected, 'suspected target distinguished from clear');checks.push('suspectedVsClear');

      f = fixture({height: 500});r = await run(f, [target(f.rows[0]), target(f.rows[1])]);
      assert(r.targeting.scanMethod === 'full' && r.blocks.length === 2 && r.targeting.coverage === 'complete', 'multiple adjacent visible targets must use full scan');checks.push('multipleTargetsFullFallback');

      f = fixture({text: i => i === 3 ? '很长的自动换行段落'.repeat(40) : `普通文本${i}`});
      r = await run(f, [target(f.rows[3])]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.coverage === 'complete' && r.blocks.length === 1, 'oversized paragraph must use existing full scanner and filter');checks.push('oversizedTargetFullFallback');

      f = fixture();const old = f.contexts.get(f.rows[2].owner);
      f.contexts.set(f.rows[2].owner, {...old, info: {...old.info, text: 'stale'}});
      r = await run(f, [target(f.rows[2])]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered' && r.blocks.length === 0, 'stale mapping must not produce clear');checks.push('staleMappingUncovered');

      f = fixture({text: i => i === 1 || i === 7 ? '重复段落' : `普通文本${i}`});
      r = await run(f, [{kind: 'paragraph', text: '重复段落'}]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered' && r.blocks.length === 2, 'duplicate source text must not choose first match');checks.push('ambiguousParagraphFullUncovered');

      f = fixture();r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.coverage === 'complete' && r.blocks.length === 12, 'section boundary and full fallback failed');checks.push('sectionResolution');

      f = fixture({count: 1, height: 250});r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.scanMethod === 'visible' && r.targeting.coverage === 'complete', 'small single section should use visible scan');checks.push('singleSectionLocal');

      f = fixture();r = await run(f, [{kind: 'lines', startLine: f.rows[4].startLine, endLine: f.rows[4].endLine}]);
      assert(r.targeting.scanMethod === 'visible' && r.blocks.length === 1 && r.targeting.targets[0].measuredBlocks === 1, '1-based line filtering failed');checks.push('oneBasedLines');

      f = fixture();f.cache.sections[3].type = 'table';
      const table = document.createElement('table');table.innerHTML = '<tr><td>未支持</td></tr>';f.rows[2].owner.replaceChildren(table);
      r = await run(f, [{kind: 'lines', startLine: f.rows[2].startLine, endLine: f.rows[2].endLine}]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered', 'unsupported table must not clear even when source section was traversed');checks.push('unsupportedTableUncovered');

      f = fixture();f.rows[2].owner.className = 'callout is-collapsed';
      r = await run(f, [target(f.rows[2])]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered', 'collapsed callout must not clear');checks.push('collapsedTargetUncovered');

      f = fixture();f.rows[2].owner.style.cssText = 'height:10px;overflow:hidden';
      r = await run(f, [target(f.rows[2])]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered', 'clipped target must not clear');checks.push('clippedTargetUncovered');

      f = fixture();r = await run(f, [{kind: 'paragraph', text: '不存在的目标'}]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered' && r.blocks.length === 0, 'missing target zero results must not clear');checks.push('missingTargetNotClear');

      f = fixture();f.plugin.cancelled = true;
      let failed = false;try {await run(f, [target(f.rows[3])]);} catch (e) {failed = e.message.includes('取消');}
      assert(failed, 'cancel must fail, not be translated to uncovered or clear');checks.push('scanFailurePropagated');

      f = fixture();let rejected = 0;
      for (const input of [[], [{kind: 'lines', startLine: 0, endLine: 1}], [{kind: 'lines', startLine: 2, endLine: 1}], [{kind: 'lines', startLine: 1.5, endLine: 2}], [{kind: 'lines', startLine: 1, endLine: 999}], [{kind: 'unknown'}]]) {
        try {window.targetModule.resolveTargets(input, f.source, f.cache);} catch {rejected++;}
      }
      assert(rejected === 6, 'invalid target validation failed');checks.push('invalidTargetsRejected');

      f = fixture();const first = f.rows[0], second = f.rows[1];
      first.owner.append(second.p);second.owner.remove();
      const info = {lineStart: first.startLine - 1, lineEnd: second.endLine - 1, text: f.source};
      f.contexts.set(first.owner, {ctx: {sourcePath: f.file.path, getSectionInfo: () => info}, info});
      f.cache.sections.splice(1, 2, {type: 'blockquote', position: {start: {line: info.lineStart}, end: {line: info.lineEnd}}});
      r = await run(f, [{kind: 'lines', startLine: first.startLine, endLine: first.endLine}]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered' && r.blocks.length === 2, 'coarse multi-paragraph mapping cannot claim precise coverage');checks.push('coarseMappingUncovered');

      f = fixture();const headingSource = '## 章\n\n段落\n\n### 节\n\n正文\n\n## 下一章';
      const headingCache = {sections: [0,4,8].map(line => ({type: 'heading', position: {start: {line}, end: {line}}})),
        headings: [{heading:'章',level:2,position:{start:{line:0}}},{heading:'节',level:3,position:{start:{line:4}}},{heading:'下一章',level:2,position:{start:{line:8}}}]};
      const nested = window.targetModule.resolveTargets([{kind: 'section', headingPath:['章','节']}], headingSource, headingCache);
      assert(nested[0].resolved && nested[0].ranges[0].startLine === 5 && nested[0].ranges[0].endLine === 8, 'nested heading boundary failed');checks.push('nestedSectionBounds');

      const duplicateCache = {sections: [0,4].map(line => ({type:'heading',position:{start:{line},end:{line}}})),
        headings: [{heading:'章',level:2,position:{start:{line:0}}},{heading:'章',level:2,position:{start:{line:4}}}]};
      const duplicate = window.targetModule.resolveTargets([{kind:'section',headingPath:['章']}], '## 章\n\n正文\n\n## 章\n\n正文', duplicateCache);
      assert(!duplicate[0].resolved && duplicate[0].ranges.length === 2, 'duplicate heading must not resolve first');checks.push('duplicateHeadingAmbiguous');

      const comment = window.targetModule.resolveTargets([{kind:'section',headingPath:['注释']}], '```sh\n# 注释\n```',
        {sections:[{type:'code',position:{start:{line:0},end:{line:2}}}],headings:[{heading:'注释',level:1,position:{start:{line:1}}}]});
      assert(!comment[0].resolved && comment[0].ranges.length === 0, 'stale code comment metadata must not resolve a heading');checks.push('codeCommentNotSection');

      f = fixture();const absent = f.contexts.get(f.rows[2].owner);
      f.contexts.set(f.rows[2].owner, {...absent, info: {lineStart: absent.info.lineStart, lineEnd: absent.info.lineEnd}});
      r = await run(f, [target(f.rows[2])]);
      assert(r.targeting.scanMethod === 'full' && r.scan.complete && r.targeting.result === 'uncovered', 'legacy full coverage alone is not targeted source-version proof');checks.push('missingVersionEvidenceUncovered');

      f = fixture();f.cache.sections.splice(4, 1);
      r = await run(f, [{kind:'section',headingPath:['章节']}]);
      assert(r.targeting.result === 'uncovered', 'rendered blocks omitted by metadata cannot clear a target');checks.push('metadataOmissionUncovered');

      const staleBoundary = window.targetModule.resolveTargets([{kind:'section',headingPath:['章']}], '## 章\n\n正文\n\n## 新章',
        {sections:[0,4].map(line=>({type:'heading',position:{start:{line},end:{line}}})),headings:[{heading:'章',level:2,position:{start:{line:0}}},{heading:'旧章',level:2,position:{start:{line:4}}}]});
      assert(!staleBoundary[0].resolved, 'stale next heading must not define trusted chapter boundary');checks.push('staleChapterBoundaryUncovered');

      function mixedMapping() {
        const mixed = fixture({count: 2, height: 500}), first = mixed.rows[0], second = mixed.rows[1];
        first.owner.append(second.p);second.owner.remove();
        const info = {lineStart: first.startLine - 1, lineEnd: second.endLine - 1, text: mixed.source};
        mixed.contexts.set(first.owner, {ctx: {sourcePath: mixed.file.path, getSectionInfo: () => info}, info});
        mixed.cache.sections.splice(1, 2, {type: 'blockquote', position: {start: {line: info.lineStart}, end: {line: info.lineEnd}}});
        return mixed;
      }
      function makeSecondStale(mixed) {
        const record = mixed.contexts.get(mixed.rows[0].owner);
        mixed.contexts.set(mixed.rows[1].p, {...record, info: {...record.info, text: 'stale'}});
      }
      f = mixedMapping();makeSecondStale(f);
      r = await run(f, [{kind: 'lines', startLine: f.rows[0].startLine, endLine: f.rows[1].endLine}]);
      assert(f.calls.length === 1 && f.calls[0].full && r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered', 'partly trusted target must fall back and never clear');
      checks.push('partlyTrustedMappingFullFallback');

      f = mixedMapping();
      const inspect = f.hooks.inspect;
      f.hooks.inspect = (...args) => {makeSecondStale(f);return inspect(...args);};
      r = await run(f, [{kind: 'lines', startLine: f.rows[0].startLine, endLine: f.rows[1].endLine}]);
      assert(!f.calls[0].full && r.scan.missingSourceLocations && r.targeting.result === 'uncovered', 'mapping lost after localization cannot produce local clear');
      checks.push('mappingLostDuringLocalScanUncovered');

      f = mixedMapping();const inspectWithoutVersion = f.hooks.inspect;
      f.hooks.inspect = (...args) => {
        const record = f.contexts.get(f.rows[0].owner), {text, ...info} = record.info;
        f.contexts.set(f.rows[1].p, {...record, info});return inspectWithoutVersion(...args);
      };
      r = await run(f, [{kind:'lines',startLine:f.rows[0].startLine,endLine:f.rows[1].endLine}]);
      assert(!f.calls[0].full && !r.scan.missingSourceLocations && r.targeting.result === 'uncovered', 'source locations alone cannot cover loss of trustworthy rendering version');
      checks.push('versionEvidenceLostDuringLocalScanUncovered');

      const pos = line => ({start: {line}, end: {line}});
      const parentCache = {sections: [0,1].map(line => ({type:'heading',position:pos(line)})),
        headings: [{heading:'Old',level:1,position:pos(0)},{heading:'Child',level:2,position:pos(1)}]};
      const staleParent = window.targetModule.resolveTargets([{kind:'section',headingPath:['Old','Child']}], '# New\n## Child\ntext', parentCache);
      const staleParentHint = window.targetModule.resolveTargets([{kind:'lines',startLine:3,endLine:3,headingPath:['Old','Child']}], '# New\n## Child\ntext', parentCache);
      assert(!staleParent[0].resolved && !staleParentHint[0].resolved, 'all heading ancestors must match source, including explicit line hints');
      checks.push('staleHeadingAncestorRejected');

      const staleLevels = window.targetModule.resolveTargets([{kind:'section',headingPath:['A']}], '## A\ntext\n# B\nother',
        {sections:[0,2].map(line=>({type:'heading',position:pos(line)})),headings:[{heading:'A',level:1,position:pos(0)},{heading:'B',level:2,position:pos(2)}]});
      assert(!staleLevels[0].resolved, 'cached heading level must agree with source before determining section bounds');
      const staleBoundaryLevel = window.targetModule.resolveTargets([{kind:'section',headingPath:['A']}], '## A\ntext\n# B\nother',
        {sections:[0,2].map(line=>({type:'heading',position:pos(line)})),headings:[{heading:'A',level:2,position:pos(0)},{heading:'B',level:3,position:pos(2)}]});
      assert(!staleBoundaryLevel[0].resolved, 'a stale higher cached level cannot hide the actual next section boundary');
      f = fixture({count:1,height:500});f.cache.headings[0].level = 1;
      r = await run(f, [{kind:'section',headingPath:['章节']}]);
      assert(f.calls[0].full && r.targeting.result === 'uncovered', 'wrong heading level must use full scan without trusted target coverage');
      checks.push('staleHeadingLevelFullFallback');

      const setext = window.targetModule.resolveTargets([{kind:'section',headingPath:['Title']}], 'Title\n=====\ntext',
        {sections:[{type:'heading',position:{start:{line:0},end:{line:1}}}],headings:[{heading:'Title',level:1,position:pos(0)}]});
      assert(setext[0].resolved, 'source level validation must preserve simple Setext headings');checks.push('setextHeadingLevelValidated');

      // Extend the existing synthetic browser setup; published fixtures stay unchanged.
      function chapters() {
        const f = fixture({count: 6, height: 110, text: i => i === 3 ? '测试'.repeat(7) + '测' : `普通文本${i}`});
        const lines = f.source.split('\n'), boundary = f.rows[3].startLine - 2;
        lines[boundary] = '## Target';f.source = lines.join('\n');
        for (const [, record] of f.contexts) record.info.text = f.source;
        const owner = document.createElement('div');owner.innerHTML = '<h2>Target</h2>';
        f.rows[3].owner.before(owner);
        const info = {lineStart: boundary, lineEnd: boundary, text: f.source};
        f.contexts.set(owner, {ctx: {sourcePath: f.file.path, getSectionInfo: () => info}, info});
        f.cache.sections.push({type: 'heading', position: {start: {line: boundary}, end: {line: boundary}}});
        f.cache.sections.sort((a, b) => a.position.start.line - b.position.start.line);
        f.cache.headings.push({heading: 'Target', level: 2, position: {start: {line: boundary}}});
        f.plugin.app.vault.read = async () => f.source;f.view.previewMode.get = () => f.source;
        f.chapter = {kind: 'section', headingPath: ['Target']};
        return f;
      }
      // Boundary diagnostics must not change scan method, measurements or acceptance.
      f = chapters();r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      let plan = r.targeting.targets[0].sectionPlan;
      assert(plan.status === 'ready' && plan.startOwner.sourceRange.startLine === 1 &&
        plan.endOwner.sourceRange.startLine === f.rows[3].startLine - 1, 'ordinary chapter needs trusted boundaries');
      assert(r.targeting.scanMethod === 'full' && r.blocks.length === 3 && r.targeting.coverage === 'complete', 'ready diagnostic must preserve full scanning and results');
      assert(JSON.parse(JSON.stringify(r)).targeting.targets[0].sectionPlan.startOwner.tagName === 'DIV', 'owner diagnostics must serialize without DOM identity');
      checks.push('sectionPlanReadyDiagnosticOnly');

      for (const mode of ['outside', 'inside', 'unavailable']) {
        f = chapters();
        const gapOwner = document.createElement('div');gapOwner.innerHTML = '<p>unmapped diagnostic text</p>';
        const gapNode = gapOwner.firstElementChild;
        if (mode === 'inside') f.rows[1].owner.before(gapOwner);
        else f.rows[4].owner.after(gapOwner);
        const unknownRecord = {ctx: {sourcePath: f.file.path, getSectionInfo: () => null}, info: {text: 'stale'}};
        f.contexts.set(gapOwner, unknownRecord);f.contexts.set(gapNode, unknownRecord);
        const gapTargets = window.targetModule.resolveTargets([{kind: 'section', headingPath: ['章节']}], f.source, f.cache);
        const gapTracker = new window.targetModule.TargetTracker(gapTargets, f.plugin, f.source, f.file.path, f.hooks);
        if (mode === 'unavailable') f.rows[3].owner.previousElementSibling.querySelector('h2').textContent = 'Wrong boundary';
        gapTracker.observe(f.root, {blocks: [], skipped: []});
        const report = await f.hooks.inspect(f.view, f.plugin, true, (root, result) => gapTracker.observe(root, result));
        // Model an unresolved source gap while preserving its independently
        // observed DOM identity and boundary membership.
        for (const [key, gap] of gapTracker.mappingGaps) if (key.node === gapNode)
          gapTracker.mappingGaps.set(key, {...gap, possibleRange: null});
        const filtered = gapTracker.filter(report, 'full'), resultTarget = filtered.targeting.targets[0];
        if (mode === 'outside') assert(resultTarget.coverage === 'complete' &&
          resultTarget.ignoredOutsideSectionGaps.some(g => g.possibleRange === null), 'ready boundary excludes proven outside null gaps');
        else if (mode === 'inside') assert(resultTarget.sectionPlan.status === 'ready' && resultTarget.coverage === 'complete' &&
          resultTarget.measuredBlocks > 0 && resultTarget.mappingPrecision === 'partial' &&
          resultTarget.checkedInsideSectionGaps.length > 0, 'inside null gap is diagnostic when the section has measured blocks: ' + JSON.stringify({plan: resultTarget.sectionPlan.status, coverage: resultTarget.coverage, measuredBlocks: resultTarget.measuredBlocks, precision: resultTarget.mappingPrecision, gaps: resultTarget.checkedInsideSectionGaps.length, reasons: resultTarget.reasons}));
        else assert(resultTarget.sectionPlan.status === 'unavailable' && resultTarget.coverage === 'uncovered' &&
          resultTarget.ignoredOutsideSectionGaps.length === 0, 'unavailable boundary retains old null-gap blocking');
        checks.push('sectionCoverageDomBoundary_' + mode);
      }


      f = chapters();
      for (const row of f.rows.slice(0, 3)) {
        const record = f.contexts.get(row.owner);
        f.contexts.set(row.owner, {...record, info: {...record.info, text: 'stale'}});
      }
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      plan = r.targeting.targets[0].sectionPlan;
      assert(plan.status === 'ready' && plan.sectionDomRange.endExclusive &&
        plan.boundaryEvidence.contentCoverageChecked === false && plan.contentNodesUnchecked.length === 3,
        'title boundaries do not require mapped body owners');
      assert(r.targeting.coverage === 'complete' && r.targeting.targets[0].mappingPrecision === 'partial' && r.blocks.length === 3,
        'ready section accepts measured DOM content with partial source precision');
      checks.push('sectionPlanPartialMappingRenderedComplete');

      f = chapters();f.rows[1].owner.remove();
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'ready' && r.targeting.coverage === 'uncovered',
        'ready title boundaries do not excuse a missing expected body block');
      checks.push('sectionRenderedMissingExpectedUncovered');

      f = chapters();const unmeasuredSpan = document.createElement('span');unmeasuredSpan.textContent = '未参与检测的文本';
      f.rows[1].owner.append(unmeasuredSpan);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.coverage === 'uncovered', 'text outside all measured nodes must still fail');
      checks.push('sectionUnmeasuredTextStillUncovered');


      f = chapters();
      for (const row of f.rows.slice(0, 3)) f.contexts.set(row.owner,
        {ctx: {sourcePath: f.file.path, getSectionInfo: () => null}, info: {text: 'stale'}});
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.coverage === 'complete' && r.blocks.length === 3 &&
        r.blocks.every(block => block.sourceStartLine === null && block.mappingPrecision === 'partial'),
        'unlocated measurements must survive target report filtering through DOM membership');
      checks.push('sectionRenderedWithoutSourceLinesComplete');

      f = chapters();stale(f, f.rows[1].owner);
      f.rows[3].owner.previousElementSibling.querySelector('h2').textContent = 'Wrong boundary';
      const staleRecord = f.contexts.get(f.rows[0].owner);
      f.contexts.set(f.rows[0].owner, {...staleRecord, info: {...staleRecord.info, text: 'stale'}});
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' && r.targeting.coverage === 'uncovered',
        'unavailable section must retain exact source coverage requirements');
      checks.push('sectionRenderedUnavailableKeepsOldCoverage');


      f = chapters();
      f.rows[0].owner.append(f.rows[4].owner);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' &&
        r.targeting.targets[0].sectionPlan.reason.includes('跨章节'), 'known outside descendant must reject a cross-chapter container');
      checks.push('sectionPlanCrossChapterContainerRejected');

      f = chapters();
      const crossingTargets = window.targetModule.resolveTargets([{kind: 'section', headingPath: ['章节']}], f.source, f.cache);
      const crossingTracker = new window.targetModule.TargetTracker(crossingTargets, f.plugin, f.source, f.file.path, f.hooks);
      crossingTracker.observe(f.root, {blocks: [], skipped: []});
      assert(crossingTracker.sectionPlanDiagnostic(crossingTargets[0]).status === 'ready', 'initial boundary must be ready');
      f.rows[0].owner.append(f.rows[4].owner);
      crossingTracker.observe(f.root, {blocks: [], skipped: []});
      assert(crossingTracker.sectionPlanDiagnostic(crossingTargets[0]).status === 'unavailable',
        'later cross-chapter evidence must invalidate an earlier ready snapshot');
      checks.push('sectionPlanCachedCrossChapterRejected');


      f = chapters();
      const extraHeading = document.createElement('div');extraHeading.innerHTML = '<h2>Unexpected chapter</h2>';
      f.rows[1].owner.before(extraHeading);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable', 'intervening same-level heading cannot be crossed');
      checks.push('sectionPlanInterveningChapterRejected');


      // Simulate virtual rendering after evidence collection, without running
      // another scan or changing the coverage inputs.
      f = chapters();
      const cachedTargets = window.targetModule.resolveTargets([{kind: 'section', headingPath: ['章节']}], f.source, f.cache);
      const cachedTracker = new window.targetModule.TargetTracker(cachedTargets, f.plugin, f.source, f.file.path, f.hooks);
      cachedTracker.observe(f.root, {blocks: [], skipped: []});
      const cachedBefore = cachedTracker.sectionPlanDiagnostic(cachedTargets[0]);
      assert(cachedBefore.status === 'ready', 'connected snapshot must first prove boundaries');
      f.root.querySelectorAll('h2').forEach(node => node.parentElement.remove());
      const cachedAfter = cachedTracker.sectionPlanDiagnostic(cachedTargets[0]);
      assert(cachedAfter.status === 'ready' && cachedAfter.evidenceSource === 'during-scan' &&
        cachedAfter.startHeading.headingDuringScanFound && !cachedAfter.startHeading.headingAfterScanFound &&
        cachedAfter.endHeading.headingDuringScanFound && !cachedAfter.endHeading.headingAfterScanFound,
        'virtual removal after scanning must preserve the earlier boundary proof');
      assert(cachedAfter.headingSnapshots[0].candidates[0].tagName === 'H2' &&
        cachedAfter.headingSnapshots[0].candidates[0].domIndex === 0 &&
        cachedAfter.headingSnapshots[0].state.step === 1, 'heading evidence needs immutable text, level, order and scan state');
      JSON.stringify(cachedAfter);
      checks.push('sectionPlanCachedVirtualRemoval');

      f = chapters();
      const duplicateTargets = window.targetModule.resolveTargets([{kind: 'section', headingPath: ['章节']}], f.source, f.cache);
      const duplicateTracker = new window.targetModule.TargetTracker(duplicateTargets, f.plugin, f.source, f.file.path, f.hooks);
      duplicateTracker.observe(f.root, {blocks: [], skipped: []});
      const duplicateEnd = f.rows[3].owner.previousElementSibling;
      duplicateEnd.after(duplicateEnd.cloneNode(true));
      duplicateTracker.observe(f.root, {blocks: [], skipped: []});
      assert(duplicateTracker.sectionPlanDiagnostic(duplicateTargets[0]).status === 'unavailable',
        'later duplicate evidence must invalidate a previously ready snapshot');
      checks.push('sectionPlanCachedDuplicateRejected');


      f = chapters();r = await run(f, [f.chapter]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' &&
        r.targeting.targets[0].sectionPlan.reason.includes('document-end') && r.targeting.coverage === 'complete', 'last chapter has no supported end boundary but existing coverage remains complete');
      checks.push('sectionPlanLastChapterUnavailable');

      f = chapters();r = await run(f, [{kind: 'section', headingPath: ['missing']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' && !r.targeting.targets[0].resolved, 'unresolved path cannot create a plan');
      checks.push('sectionPlanUnresolvedUnavailable');

      f = chapters();f.root.prepend(f.rows[3].owner.previousElementSibling);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' && r.targeting.targets[0].sectionPlan.reason.includes('DOM 顺序'), 'reversed heading owners cannot form a plan');
      checks.push('sectionPlanReversedBoundariesUnavailable');

      f = chapters();f.rows[0].owner.before(f.rows[1].owner);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' && r.targeting.targets[0].sectionPlan.reason.includes('DOM 顺序'), 'reordered internal source owners cannot form a plan');
      checks.push('sectionPlanReorderedInteriorUnavailable');

      f = chapters();const endingOwner = f.rows[3].owner.previousElementSibling;
      const endingRecord = f.contexts.get(endingOwner);
      f.contexts.set(endingOwner, {...endingRecord, info: {...endingRecord.info, text: 'stale'}});
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'ready' && r.targeting.targets[0].sectionPlan.endHeading.textMatches &&
        r.targeting.targets[0].sectionPlan.endHeading.levelMatches && r.targeting.targets[0].sectionPlan.orderPassed,
        'heading boundary can use unique DOM text, level and source order without LayoutContext');
      checks.push('sectionPlanHeadingWithoutLayoutContext');

      f = fixture({count: 1, height: 250});r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' && r.targeting.scanMethod === 'visible' &&
        r.targeting.coverage === 'complete' && r.blocks.length === 1 && r.scan.steps === 1, 'unavailable diagnostic must preserve visible scanning');
      checks.push('sectionPlanVisibleBehaviorUnchanged');

      f = chapters();const endOriginal = f.rows[3].owner.previousElementSibling;
      const endDuplicate = endOriginal.cloneNode(true);endOriginal.after(endDuplicate);
      f.contexts.set(endDuplicate, f.contexts.get(endOriginal));
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' && r.targeting.targets[0].sectionPlan.reason.includes('重复') &&
        r.targeting.targets[0].sectionPlan.endHeading.domMatches === 2, 'duplicate ending title cannot prove a boundary');
      checks.push('sectionPlanDuplicateOwnerUnavailable');

      f = chapters();f.rows[3].owner.previousElementSibling.querySelector('h2').textContent = 'Other title';
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' &&
        r.targeting.targets[0].sectionPlan.endHeading.textMatches === false &&
        r.targeting.targets[0].sectionPlan.reason.includes('文本'), 'changed DOM heading text must fail');
      checks.push('sectionPlanHeadingTextMismatch');

      f = chapters();const oldH2 = f.rows[3].owner.previousElementSibling.querySelector('h2');
      const wrongLevel = document.createElement('h3');wrongLevel.textContent = oldH2.textContent;oldH2.replaceWith(wrongLevel);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' &&
        r.targeting.targets[0].sectionPlan.endHeading.textMatches === true &&
        r.targeting.targets[0].sectionPlan.endHeading.levelMatches === false &&
        r.targeting.targets[0].sectionPlan.reason.includes('层级'), 'changed DOM heading level must fail');
      checks.push('sectionPlanHeadingLevelMismatch');

      f = chapters();const endWrapped = f.rows[3].owner.previousElementSibling;
      const wrapper = document.createElement('div');endWrapped.before(wrapper);wrapper.append(endWrapped);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'unavailable' && r.targeting.targets[0].sectionPlan.reason.includes('父容器'), 'different parent boundaries need a continuous-range proof');
      checks.push('sectionPlanDifferentParentsUnavailable');

      function stale(f, el) {
        const record = f.contexts.get(el);
        f.contexts.set(el, {...record, info: {...record.info, text: 'stale'}});
      }
      f = chapters();stale(f, f.rows[0].owner);
      r = await run(f, [f.chapter]);
      assert(r.targeting.scanMethod === 'full' && !r.scan.complete && r.scan.missingSourceLocations && r.documentCoverage === 'incomplete', 'document diagnostics must retain outside mapping gaps');
      assert(r.targeting.coverage === 'complete' && r.targeting.result === 'suspected' && r.blocks.length === 3 && r.targeting.targets[0].mappingGaps.length === 0, 'outside unknown text must not block a fully measured chapter');
      checks.push('chapterCompleteWithDocumentIncomplete');

      f = chapters();stale(f, f.rows[0].owner);f.rows[3].p.style.width = '150px';
      r = await run(f, [f.chapter]);
      assert(r.documentCoverage === 'incomplete' && r.targeting.coverage === 'complete' && r.targeting.result === 'clear', 'chapter without short tails must clear independently of document gaps');checks.push('chapterClearWithDocumentIncomplete');

      f = chapters();stale(f, f.rows[0].owner);
      const outsideImage = document.createElement('img');f.rows[0].owner.append(outsideImage);
      r = await run(f, [f.chapter]);
      assert(r.targeting.coverage === 'complete' && !r.scan.complete, 'outside unmapped unsupported content must not block target');checks.push('outsideUnknownUnsupportedDoesNotBlockChapter');

      f = chapters();stale(f, f.rows[0].owner);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}, f.chapter]);
      assert(r.targeting.targets[0].coverage === 'complete' && r.targeting.targets[0].mappingPrecision === 'partial' &&
        r.targeting.targets[1].coverage === 'complete' && r.targeting.coverage === 'complete',
        'measured partial mapping in a ready chapter must remain independent of the other target');checks.push('chapterMappingPrecisionIsIndependent');

      f = chapters();stale(f, f.rows[1].owner);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'ready' && r.targeting.targets[0].measuredBlocks > 0 &&
        r.targeting.coverage === 'complete' && r.targeting.targets[0].mappingPrecision === 'partial' &&
        r.targeting.targets[0].mappingGaps.length > 0,
        'a ready section with measured blocks must accept mapping gaps as partial precision: ' + JSON.stringify({plan: r.targeting.targets[0].sectionPlan.status, coverage: r.targeting.coverage, measured: r.targeting.targets[0].measuredBlocks, precision: r.targeting.targets[0].mappingPrecision, gaps: r.targeting.targets[0].mappingGaps.length, reasons: r.targeting.targets[0].reasons}));checks.push('sectionReadyMappingGapPartialAccepted');

      f = chapters();for (const row of f.rows.slice(0, 3)) row.owner.remove();
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'ready' && r.targeting.targets[0].measuredBlocks === 0 &&
        r.targeting.coverage === 'uncovered', 'a section without measured content must remain uncovered');checks.push('sectionReadyWithoutMeasuredContentUncovered');

      f = chapters();stale(f, f.rows[1].owner);
      const unsupportedImage = document.createElement('img');f.rows[1].owner.append(unsupportedImage);
      r = await run(f, [{kind: 'section', headingPath: ['章节']}]);
      assert(r.targeting.targets[0].sectionPlan.status === 'ready' && r.targeting.targets[0].measuredBlocks > 0 &&
        r.targeting.coverage === 'uncovered' && r.targeting.targets[0].mappingGaps.some(gap => gap.kind === 'unsupported'),
        'unsupported content remains uncovered even when another mapping gap is present');checks.push('sectionUnsupportedGapStillUncovered');

      f = chapters();const sibling = document.createElement('p');sibling.textContent = '未映射兄弟节点';f.rows[3].owner.after(sibling);
      r = await run(f, [f.chapter]);
      assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].mappingGaps.length > 0, 'unmapped node between target owners must block target');checks.push('unmappedTargetSiblingStillFails');

      f = chapters();f.rows[4].owner.remove();
      r = await run(f, [f.chapter]);
      assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].reasons.some(reason => reason.includes('缺少可信渲染映射')), 'expected target block must not disappear silently');checks.push('missingChapterExpectedBlockStillFails');

      f = chapters();const insideImage = document.createElement('img');f.rows[3].owner.append(insideImage);
      r = await run(f, [f.chapter]);
      assert(r.targeting.coverage === 'uncovered', 'supported text cannot conceal unsupported target content');checks.push('unsupportedChapterContentStillFails');

      f = chapters();stale(f, f.rows[0].owner);f.rows[1].owner.before(f.rows[2].owner);
      r = await run(f, [f.chapter]);
      assert(r.documentCoverage === 'incomplete' && r.targeting.coverage === 'complete' &&
        r.targeting.targets[0].mappingGaps.length === 0 && r.targeting.targets[0].measuredBlocks === 3 && r.targeting.targets[0].suspected === 1,
        'unrelated anchor reorderings must not globally block an outside unknown');checks.push('outsideUnknownWithUnrelatedReorderingDoesNotBlockChapter');

      f = chapters();stale(f, f.rows[0].owner);f.rows[0].owner.before(f.rows[4].owner);
      r = await run(f, [f.chapter]);
      assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].mappingGaps.some(gap => gap.possibleRange === null),
        'crossed source bounds must remain unknown and fail closed');checks.push('crossedUnknownScopeStillFails');

      f = chapters();
      const boundaryText = document.createElement('p');boundaryText.textContent = '无法归属的章节边界文本';f.rows[2].owner.after(boundaryText);
      r = await run(f, [f.chapter]);
      assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].mappingGaps.some(gap =>
        gap.possibleRange?.startLine === f.rows[2].startLine && gap.possibleRange?.endLine === f.rows[3].startLine - 1),
        'an empty source gap at the chapter boundary must retain both bordering blocks');checks.push('chapterBoundaryUnknownStillFails');

      f = chapters();stale(f, f.rows[0].owner);f.rows[0].owner.before(f.rows[4].owner);
      const unknownRule = document.createElement('hr');f.rows[0].owner.append(unknownRule);
      r = await run(f, [f.chapter]);
      const paragraphDiagnostic = r.targeting.targets[0].mappingGaps.find(gap => gap.possibleRange === null && gap.diagnostic?.tagName === 'P')?.diagnostic;
      const hrDiagnostic = r.targeting.targets[0].mappingGaps.find(gap => gap.possibleRange === null && gap.diagnostic?.tagName === 'HR')?.diagnostic;
      assert(paragraphDiagnostic?.fromHrBranch === false && paragraphDiagnostic.parentTagName === 'DIV' &&
        paragraphDiagnostic.sourceContainerRange === null && paragraphDiagnostic.textContentSummary, 'ordinary unknown text diagnostics missing');
      assert(hrDiagnostic?.fromHrBranch === true && hrDiagnostic.parentTagName === 'DIV' &&
        hrDiagnostic.sourceContainerRange === null, 'hr unknown diagnostics missing');
      assert(r.targeting.coverage === 'uncovered' && r.targeting.result === 'uncovered' &&
        r.targeting.targets[0].measuredBlocks === 3 && r.targeting.targets[0].suspected === 1,
        'diagnostics must not alter target coverage or measured results');
      checks.push('unknownNodeDiagnosticsAreAdditiveAndHrBranchTagged');
      async function pendingGapCase(mode) {
        const f = chapters();
        const owner = document.createElement('div'), node = document.createElement('p');
        node.textContent = '早期没有源码上下文的文本';owner.append(node);f.root.prepend(owner);
        const targets = window.targetModule.resolveTargets([f.chapter], f.source, f.cache);
        const tracker = new window.targetModule.TargetTracker(targets, f.plugin, f.source, f.file.path, f.hooks);
        tracker.observe(f.root, {blocks: [], skipped: []});
        assert([...tracker.mappingGaps.values()].some(g => g.possibleRange === null && g.state === 'pending'), 'initial null must remain pending');
        if (mode === 'outside' || mode === 'inside') {
          const row = mode === 'outside' ? f.rows[0] : f.rows[3];
          const info = {lineStart: row.startLine - 1, lineEnd: row.endLine - 1, text: f.source};
          f.contexts.set(owner, {ctx: {sourcePath: f.file.path, getSectionInfo: () => info}, info});
          // Child remains unknown; only its parent's trustworthy scope arrives later.
          f.contexts.set(node, {ctx: {sourcePath: f.file.path, getSectionInfo: () => null}, info: {text: 'stale'}});
        } else if (mode === 'detached') owner.remove();
        else if (mode === 'moved') f.rows[3].owner.after(owner);
        const report = await f.hooks.inspect(f.view, f.plugin, true, (root, result) => tracker.observe(root, result));
        return {r: tracker.filter(report, 'full'), tracker};
      }
      let delayed = await pendingGapCase('outside');
      assert(delayed.r.targeting.coverage === 'complete' && delayed.r.targeting.targets[0].mappingGaps.length === 0 &&
        delayed.r.targeting.targets[0].measuredBlocks === 3 && delayed.r.targeting.targets[0].suspected === 1,
        'late outside source anchors must replace the original pending gap without changing measured results');
      assert([...delayed.tracker.mappingGaps.values()].some(g => g.state === 'located' && g.possibleRange), 'gap state must record later attribution');
      assert(JSON.stringify(delayed.r), 'DOM identity must not leak into the serialized report');checks.push('pendingOutsideGapLocatedLater');
      delayed = await pendingGapCase('inside');
      assert(delayed.r.targeting.coverage === 'uncovered' && delayed.r.targeting.targets[0].mappingGaps.some(g =>
        g.state === 'located' && g.possibleRange.startLine === f.rows[3].startLine), 'late attribution inside the target must still fail');checks.push('pendingInsideGapStillFails');
      for (const mode of ['unknown', 'detached', 'moved']) {
        delayed = await pendingGapCase(mode);
        assert(delayed.r.targeting.coverage === 'uncovered' && delayed.r.targeting.targets[0].mappingGaps.some(g =>
          g.state === 'pending' && g.possibleRange === null), 'unattributed or moved historical gaps must never disappear: ' + mode);
        checks.push('pendingGapStillFails_' + mode);
      }
      return checks;
    });
    console.log(JSON.stringify({passed: result.length, checks: result}, null, 2));
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exit(1);});
