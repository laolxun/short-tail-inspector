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
      const staleInfo={...old.info,text:'stale'};
      f.contexts.set(f.rows[2].owner, {ctx:{...old.ctx,getSectionInfo:()=>staleInfo},info:staleInfo});
      r = await run(f, [target(f.rows[2])]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered' && r.blocks.length === 0, 'stale mapping must not produce clear');checks.push('staleMappingUncovered');

      f = fixture({text: i => i === 1 || i === 7 ? '重复段落' : `普通文本${i}`});
      r = await run(f, [{kind: 'paragraph', text: '重复段落'}]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered' && r.blocks.length === 2, 'duplicate source text must not choose first match');checks.push('ambiguousParagraphFullUncovered');

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
      for (const input of [[], [{kind: 'lines', startLine: 0, endLine: 1}], [{kind: 'lines', startLine: 2, endLine: 1}], [{kind: 'lines', startLine: 1.5, endLine: 2}], [{kind: 'lines', startLine: 1, endLine: 999}], [{kind: 'unknown'}], [{kind: 'section', headingPath: ['章节']}], [{kind: 'lines', startLine: 1, endLine: 1, headingPath: ['章节']} ]]) {
        try {window.targetModule.resolveTargets(input, f.source, f.cache);} catch {rejected++;}
      }
      assert(rejected === 8, 'invalid target validation failed');checks.push('invalidTargetsRejected');

      f = fixture();const first = f.rows[0], second = f.rows[1];
      first.owner.append(second.p);second.owner.remove();
      const info = {lineStart: first.startLine - 1, lineEnd: second.endLine - 1, text: f.source};
      f.contexts.set(first.owner, {ctx: {sourcePath: f.file.path, getSectionInfo: () => info}, info});
      f.cache.sections.splice(1, 2, {type: 'blockquote', position: {start: {line: info.lineStart}, end: {line: info.lineEnd}}});
      r = await run(f, [{kind: 'lines', startLine: first.startLine, endLine: first.endLine}]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.result === 'uncovered' && r.blocks.length === 2, 'coarse multi-paragraph mapping cannot claim precise coverage');checks.push('coarseMappingUncovered');

      f = fixture();const absent = f.contexts.get(f.rows[2].owner);
      f.contexts.set(f.rows[2].owner, {...absent, info: {lineStart: absent.info.lineStart, lineEnd: absent.info.lineEnd}});
      r = await run(f, [target(f.rows[2])]);
      assert(r.targeting.scanMethod === 'full' && r.scan.complete && r.targeting.result === 'uncovered', 'legacy full coverage alone is not targeted source-version proof');checks.push('missingVersionEvidenceUncovered');

      f = fixture();f.cache.sections.splice(4, 1);
      r = await run(f, [{kind:'lines',startLine:1,endLine:f.source.split('\n').length}]);
      assert(r.targeting.result === 'uncovered', 'rendered blocks omitted by metadata cannot clear a target');checks.push('metadataOmissionUncovered');

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
      assert(!f.calls[0].full && !r.scan.missingSourceLocations && r.targeting.result === 'uncovered', 'live parent recovers position while the existing target guard still rejects stale child evidence');
      checks.push('staleChildPositionRecoveredButTargetStillUncovered');

      f = mixedMapping();const inspectWithoutVersion = f.hooks.inspect;
      f.hooks.inspect = (...args) => {
        const record = f.contexts.get(f.rows[0].owner), {text, ...info} = record.info;
        f.contexts.set(f.rows[1].p, {...record, info});return inspectWithoutVersion(...args);
      };
      r = await run(f, [{kind:'lines',startLine:f.rows[0].startLine,endLine:f.rows[1].endLine}]);
      assert(!f.calls[0].full && !r.scan.missingSourceLocations && r.targeting.result === 'uncovered', 'source locations alone cannot cover loss of trustworthy rendering version');
      checks.push('versionEvidenceLostDuringLocalScanUncovered');

      function rangeFixture() {
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
        f.rangeTarget = {kind: 'lines', startLine: boundary + 1, endLine: lines.length};
        return f;
      }
      const stale = (f, owner) => {const rec = f.contexts.get(owner),info={...rec.info,text:'stale'};f.contexts.set(owner,{ctx:{...rec.ctx,getSectionInfo:()=>info},info});};
      f = rangeFixture();const sibling = document.createElement('p');sibling.textContent = '未映射兄弟节点';f.rows[3].owner.after(sibling);
      r = await run(f, [f.rangeTarget]);
      assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].mappingGaps.length > 0, 'unmapped node between target owners must block target');checks.push('unmappedTargetSiblingStillFails');

      f = rangeFixture();f.rows[4].owner.remove();
      r = await run(f, [f.rangeTarget]);
      assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].reasons.some(reason => reason.includes('缺少可信渲染映射')), 'expected target block must not disappear silently');checks.push('missingRangeExpectedBlockStillFails');

      f = rangeFixture();const insideImage = document.createElement('img');f.rows[3].owner.append(insideImage);
      r = await run(f, [f.rangeTarget]);
      assert(r.targeting.coverage === 'uncovered', 'supported text cannot conceal unsupported target content');checks.push('unsupportedRangeContentStillFails');

      f = rangeFixture();stale(f, f.rows[0].owner);f.rows[1].owner.before(f.rows[2].owner);
      r = await run(f, [f.rangeTarget]);
      assert(r.documentCoverage === 'incomplete' && r.targeting.coverage === 'complete' &&
        r.targeting.targets[0].mappingGaps.length === 0 && r.targeting.targets[0].measuredBlocks === 3 && r.targeting.targets[0].suspected === 1,
        'unrelated anchor reorderings must not globally block an outside unknown');checks.push('outsideUnknownWithUnrelatedReorderingDoesNotBlockRange');

      f = rangeFixture();stale(f, f.rows[0].owner);f.rows[0].owner.before(f.rows[4].owner);
      r = await run(f, [f.rangeTarget]);
      assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].mappingGaps.some(gap => gap.possibleRange === null),
        'crossed source bounds must remain unknown and fail closed');checks.push('crossedUnknownScopeStillFails');

      f = rangeFixture();
      const boundaryText = document.createElement('p');boundaryText.textContent = '无法归属的源码范围边界文本';f.rows[2].owner.after(boundaryText);
      r = await run(f, [f.rangeTarget]);
      assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].mappingGaps.some(gap =>
        gap.possibleRange?.startLine === f.rows[2].startLine && gap.possibleRange?.endLine === f.rows[3].startLine - 1),
        'an empty source gap at the range boundary must retain both bordering blocks');checks.push('rangeBoundaryUnknownStillFails');

      f = rangeFixture();stale(f, f.rows[0].owner);f.rows[0].owner.before(f.rows[4].owner);
      const unknownRule = document.createElement('hr');f.rows[0].owner.append(unknownRule);
      r = await run(f, [f.rangeTarget]);
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
        const f = rangeFixture();
        const owner = document.createElement('div'), node = document.createElement('p');
        node.textContent = '早期没有源码上下文的文本';owner.append(node);f.root.prepend(owner);
        const targets = window.targetModule.resolveTargets([f.rangeTarget], f.source, f.cache);
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
