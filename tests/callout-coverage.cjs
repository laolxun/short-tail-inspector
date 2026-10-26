// Synthetic Obsidian metadata/contexts, real headless browser text geometry.
// No Vault, mailbox, installation, screenshots or historical report writes.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<style>body{margin:8px}p{font:16px sans-serif;width:120px;line-height:24px;margin:12px 0}h2{font:18px sans-serif}.callout-title{display:none}.callout-icon,.callout-fold{display:flex}.callout-icon::after,.callout-fold::after{content:"\\200B"}</style>');
    const scanner = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').split('class ResultModal')[0].split('\n').slice(1).join('\n');
    await page.addScriptTag({content: scanner + '\nwindow.scanner={sourceMappingFor,sectionFor,elementPath,SELECTOR,settleLayout,refreshReading,inspect,LayoutContexts};'});
    await page.addScriptTag({content: '{const module={exports:{}};\n' + fs.readFileSync(path.join(__dirname, '../target-scan.js'), 'utf8') + '\nwindow.targetModule=module.exports;}'});
    const checks = await page.evaluate(async () => {
      window.require = () => ({createHash: () => ({update() {return this;}, digest: () => 'fixture-hash'})});
      const checks = [], assert = (ok, message) => {if (!ok) throw new Error(message);};
      function fixture({height = 600, rule = '---', body = ['测试'.repeat(7) + '测', '', '第二段正文'], type = 'callout', header = '[!note] 自定义标题'} = {}) {
        document.querySelector('.nested-list-fixture')?.remove();
        document.querySelector('#fixture')?.remove();
        window.scrollTo(0,0);
        const container = document.createElement('div');container.id = 'fixture';document.body.append(container);
        const root = document.createElement('div');root.className = 'markdown-preview-view';root.style.cssText = `width:180px;height:${height}px;overflow:auto`;container.append(root);
        const lines = ['## Chapter', '', '> ' + header, ...body.map(s => '> ' + s), '', rule, '', '尾部正文'];
        const callEnd = 2 + body.length, ruleLine = callEnd + 2;
        const sections = [['heading', 0, 0], [type, 2, callEnd], ['thematicBreak', ruleLine, ruleLine], ['paragraph', ruleLine + 2, ruleLine + 2]]
          .map(([type, start, end]) => ({type, position: {start: {line: start}, end: {line: end}}}));
        const owners = [];
        const heading = document.createElement('div');heading.innerHTML = '<h2>Chapter</h2>';owners.push(heading);
        const callOwner = document.createElement('div');callOwner.innerHTML = '<div class="callout" data-callout="note"><div class="callout-title"><div class="callout-icon"><svg width="16" height="16"></svg></div><div class="callout-title-inner">自定义标题</div></div><div class="callout-content"></div></div>';
        const callout = callOwner.firstElementChild, content = callout.querySelector('.callout-content');
        if (/\][+-]/.test(header)) {
          const fold = document.createElement('div');fold.className = 'callout-fold';fold.innerHTML = '<svg width="16" height="16"></svg>';callout.querySelector('.callout-title').append(fold);
        }
        for (const text of body.join('\n').split(/\n\n+/)) {const p = document.createElement('p');p.textContent = text;content.append(p);}
        owners.push(callOwner);
        const hrOwner = document.createElement('div');hrOwner.innerHTML = '<hr>';owners.push(hrOwner);
        const tail = document.createElement('div');tail.innerHTML = '<p>尾部正文</p>';owners.push(tail);root.append(...owners);
        const source = lines.join('\n'), file = {path: 'synthetic.md', stat: {mtime: 1}}, contexts = new window.scanner.LayoutContexts();
        owners.forEach((owner, i) => {const info = {lineStart: sections[i].position.start.line, lineEnd: sections[i].position.end.line, text: source};contexts.set(owner, {ctx: {sourcePath: file.path, getSectionInfo: () => info}, info});});
        const cache = {sections, headings: [{heading: 'Chapter', level: 2, position: {start: {line: 0}, end: {line: 0}}}]};
        const plugin = {contexts, cancelled: false, app: {vault: {read: async () => source}, metadataCache: {getFileCache: () => cache}}};
        const view = {containerEl: container, file, getMode: () => 'preview', previewMode: {get: () => source, getScroll: () => root.scrollTop, rerender() {}, applyScroll: n => {root.scrollTop = n;}}};
        return {root, callout, content, callOwner, hrOwner, source, file, contexts, cache, plugin, view, hooks: {...window.scanner},
          call: {kind: 'lines', startLine: 3, endLine: callEnd + 1},
          rule: {kind: 'lines', startLine: ruleLine + 1, endLine: ruleLine + 1}};
      }
      const run = async (f, targets) => {
        if (targets) return window.targetModule.scanTargets(f.view, f.plugin, targets, f.source, f.hooks);
        // Exercise the full-note scanner; source-range tracking audits coverage only.
        const ranges = window.targetModule.resolveTargets([{kind: 'lines', startLine: 1,
          endLine: f.source.split('\n').length}], f.source, f.cache);
        const tracker = new window.targetModule.TargetTracker(ranges, f.plugin, f.source, f.file.path, f.hooks);
        const report = await f.hooks.inspect(f.view, f.plugin, true, (root, result) => tracker.observe(root, result));
        return tracker.filter(report, 'full');
      };
      const pseudo = (f, rule) => {
        const style = document.createElement('style');style.textContent = rule;f.root.append(style);
      };
      const bad = async (name, mutate, options) => {
        const f = fixture(options);mutate(f);const r = await run(f);
        assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].reasons.length, name + ' falsely covered');checks.push(name);
        return r;
      };
      function nestedListFixture({twoCallouts=false, duplicate=true}={}) {
        document.querySelectorAll('.nested-list-fixture').forEach(node=>node.remove());
        const container=document.createElement('div');container.className='nested-list-fixture';document.body.append(container);
        const root=document.createElement('div');root.className='markdown-preview-view';root.style.cssText='width:240px;height:600px;overflow:auto';container.append(root);
        const sourceLines=['## Chapter','','- 第一项标题','','  '+(duplicate?'重复正文':'普通列表段落'),'','- 第二项标题','','  > [!K]','  > '+(duplicate?'重复正文':'第一个正文')];
        if(twoCallouts)sourceLines.push('  >','','  > [!note]','  > '+(duplicate?'重复正文':'第二个正文'));
        const start=2,end=sourceLines.length-1;
        const headingOwner=document.createElement('div');headingOwner.innerHTML='<h2>Chapter</h2>';
        const listOwner=document.createElement('div');listOwner.innerHTML=`<ul><li><p>第一项标题</p><p>${duplicate?'重复正文':'普通列表段落'}</p></li><li><p>第二项标题</p></li></ul>`;
        const ul=listOwner.querySelector('ul'),second=ul.children[1];
        function callout(title,texts){const c=document.createElement('div');c.className='callout';c.dataset.callout='k';c.innerHTML=`<div class="callout-title"><div class="callout-icon"><svg width="12" height="12"></svg></div><div class="callout-title-inner" style="display:none">${title}</div></div><div class="callout-content"></div>`;for(const text of texts){const p=document.createElement('p');p.textContent=text;c.querySelector('.callout-content').append(p);}return c;}
        const one=callout('K',[duplicate?'重复正文':'第一个正文']);second.append(one);
        let two=null;if(twoCallouts){two=callout('Note',[duplicate?'重复正文':'第二个正文']);second.append(two);}
        root.append(headingOwner,listOwner);
        const source=sourceLines.join('\n'),file={path:'nested-list.md',stat:{mtime:1}},contexts=new window.scanner.LayoutContexts();
        const info={lineStart:start,lineEnd:end,text:source},headingInfo={lineStart:0,lineEnd:0,text:source};contexts.set(listOwner,{ctx:{sourcePath:file.path,getSectionInfo:()=>info},info});
        contexts.set(headingOwner,{ctx:{sourcePath:file.path,getSectionInfo:()=>headingInfo},info:headingInfo});
        const sections=[{type:'heading',position:{start:{line:0},end:{line:0}}},{type:'list',position:{start:{line:start},end:{line:end}}}];
        const cache={sections,headings:[{heading:'Chapter',level:2,position:{start:{line:0},end:{line:0}}}]};
        const plugin={contexts,cancelled:false,app:{vault:{read:async()=>source},metadataCache:{getFileCache:()=>cache}}};
        const view={containerEl:container,file,getMode:()=> 'preview',previewMode:{get:()=>source,getScroll:()=>root.scrollTop,rerender(){},applyScroll:n=>{root.scrollTop=n;}}};
        return {root,container,ul,second,one,two,source,file,contexts,cache,plugin,view,list:{kind:'lines',startLine:start+1,endLine:end+1},hooks:{...window.scanner}};
      }
      const runNested=f=>window.targetModule.scanTargets(f.view,f.plugin,[f.list],f.source,f.hooks);
      let f = fixture(), r = await run(f);
      assert(r.targeting.coverage === 'complete' && r.targeting.scanMethod === 'full' && r.scan.complete, 'native callout and rule must permit full-note coverage: ' + JSON.stringify(r.targeting));
      assert(r.blocks.length === 3 && r.blocks[0].text === '测试'.repeat(7) + '测' && r.blocks[0].lineCount > 1 && r.blocks[0].suspected, 'callout body must actually use real short-tail measurement');
      assert(r.targeting.targets[0].ranges[0].endLine === f.source.split('\n').length, 'structural exemption must preserve the full source range');
      const excluded = r.targeting.targets[0].expected.filter(s => s.textCoverage === 'excluded');
      assert(excluded.length === 1 && excluded[0].sourceText === '---' && excluded[0].startLine === f.rule.startLine && excluded[0].exclusionReason && r.sourceSha256 === 'fixture-hash', 'exclusion audit missing');
      checks.push('nativeCalloutBodyMeasuredWithTraceableFullHrExclusion');
      f=nestedListFixture();r=await runNested(f);
      assert(r.targeting.coverage==='complete'&&r.targeting.targets[0].reasons.length===0,'single nested callout must validate its own source child range: '+JSON.stringify(r.targeting));
      assert(r.blocks.length===4&&r.blocks.filter(b=>b.measurementUnit.type==='paragraph').length===4&&new Set(r.blocks.map(b=>b.key)).size===4,'nested list paragraphs must remain independent measured units');
      assert(r.blocks.some(b=>b.text==='重复正文'&&b.kind==='K知识块')&&f.one.querySelectorAll('.callout-content p').length===1,'nested child paragraph missing');checks.push('nestedListCalloutUniqueChildRangeCovered');
      f=nestedListFixture({twoCallouts:true});r=await runNested(f);
      assert(r.targeting.coverage==='complete'&&r.blocks.filter(b=>b.kind==='K知识块').length===2,'ordered distinct child ranges must map multiple list callouts');checks.push('multipleListItemsCalloutsMapByStructureNotText');
      f=nestedListFixture({twoCallouts:true});f.second.append(f.one.cloneNode(true));r=await runNested(f);
      assert(r.targeting.coverage==='uncovered'&&r.targeting.targets[0].reasons.some(s=>s.includes('唯一可信列表映射')),'duplicate DOM callout/list content must remain uncovered');checks.push('duplicateCalloutDomMappingRejected');
      f=nestedListFixture();f.cache.sections=f.cache.sections.filter(s=>s.type!=='list');r=await runNested(f);
      assert(r.targeting.coverage==='uncovered','missing list metadata must remain uncovered');checks.push('missingParentListMetadataRejected');
      f=nestedListFixture();f.ul.append(f.ul.cloneNode(true));r=await runNested(f);
      assert(r.targeting.coverage==='uncovered','nested list DOM that cannot map to flat metadata must remain uncovered');checks.push('nestedListAmbiguousContainerRejected');
      f=nestedListFixture();f.one.remove();r=await runNested(f);
      assert(r.targeting.coverage==='uncovered','source callout without rendered callout must remain uncovered');checks.push('missingRenderedNestedCalloutRejected');
      f=nestedListFixture();f.cache.sections.push({...f.cache.sections[1],type:'blockquote'});r=await runNested(f);
      assert(r.targeting.coverage==='uncovered','overlapping parent metadata must remain uncovered');checks.push('overlappingParentMetadataRejected');
      f = fixture({header: '[!warning]+ Other title'});r = await run(f, [f.call]);
      assert(r.targeting.coverage === 'complete', 'generic callout type and hidden custom title must not depend on K fixture');checks.push('genericTypeAndHiddenCustomTitle');
      assert(f.callout.querySelector('.callout-icon svg') && f.callout.querySelector('.callout-fold svg'), 'realistic icon/fold fixture missing');
      for (const [name, rule] of [
        ['zeroWidthPlaceholder', String.raw`.callout::before{content:"\200B"}.callout::after{content:"\00200b "}`],
        ['literalZeroWidthPlaceholder', '.callout::before{content:"\u200B"}'],
        ['whitespacePlaceholder', String.raw`.callout::after{content:" \9 \a \200b "}`],
        ['hiddenTitleTextPseudo', '.callout-title-inner::before{content:"隐藏标题文字"}'],
        ['hiddenTitleUnknownPseudo', '.callout-icon::before{content:counter(hidden-icon)}'],
        ['hiddenPseudo', '.callout::before{content:"隐藏伪元素";display:none}'],
        ['visibilityHiddenPseudo', '.callout::after{content:"隐藏伪元素";visibility:hidden}']
      ]) {
        f = fixture();pseudo(f, rule);r = await run(f);
        assert(r.targeting.coverage === 'complete' && r.targeting.scanMethod === 'full', name + ' falsely blocked: ' + JSON.stringify(r.targeting));checks.push(name);
      }
      f = fixture({header: '[!note]+ Custom'});f.callout.querySelector('.callout-title').style.display = 'flex';f.callout.querySelector('.callout-title-inner').textContent = '';
      r = await run(f);assert(r.targeting.coverage === 'complete', 'visible icon/fold zero-width placeholders falsely blocked');checks.push('visibleIconAndFoldPlaceholders');
      for (const [name, rule] of [
        ['visibleBeforeText', '.callout::before{content:"未测文字"}'],
        ['visibleAfterText', '.callout-content p::after{content:"额外正文"}'],
        ['mixedPlaceholderAndText', String.raw`.callout::after{content:"\200B 未测"}`],
        ['unknownCounter', '.callout::before{content:counter(callout-index)}'],
        ['unknownUrl', '.callout::after{content:url("data:,")}'],
        ['mixedGeneratedSyntax', '.callout::before{content:"占位" counter(callout-index)}'],
        ['attrText', '.callout::before{content:attr(data-callout)}'],
        ['escapedVisibleCharacter', String.raw`.callout::before{content:"\41"}`],
        ['otherFormatControlNotExempt', String.raw`.callout::before{content:"\200D"}`],
        ['zeroWidthBoxOverflowText', '.callout::after{content:"可见溢出文字";display:block;width:0;height:0;overflow:visible}'],
        ['clippedGeneratedTextConservative', '.callout::after{content:"裁切文字";display:block;width:0;height:0;overflow:hidden}']
      ]) {
        r = await bad(name, f => pseudo(f, rule));
        const reason = r.targeting.targets[0].reasons.find(s => s.includes('Callout 含未测生成内容'));
        assert(reason && /节点 .*::(?:before|after)/.test(reason) && reason.includes('content='), name + ' missing blocker location/content');
      }
      r = await bad('visibleIconTextNotExempt', f => {
        f.callout.querySelector('.callout-title').style.display = 'flex';f.callout.querySelector('.callout-title-inner').textContent = '';
        pseudo(f, '.callout-icon::after{content:"图标文字"}');
      });
      assert(r.targeting.targets[0].reasons.some(s => s.includes('::after') && s.includes('非纯排版占位')), 'visible icon text diagnostic missing');
      await bad('pseudoVisibilityOverridesHiddenParent', f => {
        f.callout.querySelector('.callout-title').style.cssText = 'display:flex;visibility:hidden';
        pseudo(f, '.callout-icon::after{content:"可见文字";visibility:visible}');
      });
      await bad('visibleCustomTitleUncovered', f => f.callout.querySelector('.callout-title').style.display = 'block');
      await bad('visibleDefaultTitleUncovered', f => {const t = f.callout.querySelector('.callout-title');t.textContent = 'Note';t.style.display = 'block';}, {header: '[!note]'});
      await bad('titleChildOverridesHiddenVisibilityUncovered', f => {const t = f.callout.querySelector('.callout-title');t.style.cssText = 'display:block;visibility:hidden';t.querySelector('.callout-title-inner').style.visibility = 'visible';});
      await bad('generatedTextUncovered', f => {f.callout.classList.add('generated');const style = document.createElement('style');style.textContent = '.generated::before{content:"未测文本"}';f.root.append(style);});
      await bad('collapsedNativeCalloutUncovered', f => f.callout.classList.add('is-collapsed'));
      await bad('missingParagraphUncovered', f => f.content.lastElementChild.remove());
      await bad('missingBodyContainerUncovered', f => f.content.remove());
      await bad('wrongBodyTextUncovered', f => f.content.firstElementChild.textContent = '错误正文');
      await bad('extraUnmeasuredBodyDivUncovered', f => {const d = document.createElement('div');d.textContent = '额外正文';f.content.append(d);});
      await bad('extraUnmeasuredContainerTextUncovered', f => f.callout.append('额外文本'));
      await bad('partiallyHiddenBodyUncovered', f => {const p = f.content.firstElementChild;p.innerHTML = '<span>测试</span><span style="display:none">' + '测试'.repeat(6) + '测</span>';});
      await bad('visibilityHiddenBodyUncovered', f => f.content.firstElementChild.style.visibility = 'hidden');
      await bad('clippedBodyUncovered', f => f.content.style.cssText = 'height:10px;overflow:hidden');
      await bad('embeddedBodyUncovered', f => f.content.firstElementChild.classList.add('markdown-embed'));
      f = fixture();
      const liveCallout = f.contexts.get(f.callOwner);
      f.contexts.set(f.callOwner, {...liveCallout, info: {...liveCallout.info, text: 'stale'}});
      r = await run(f, [f.call]);
      assert(r.targeting.coverage === 'complete', 'trusted live Callout must survive stale registration');
      checks.push('liveCalloutSurvivesStaleRegistration');
      await bad('staleCalloutVersionUncovered', f => {
        const rec = f.contexts.get(f.callOwner), info = {...rec.info, text: 'stale'};
        f.contexts.set(f.callOwner, {ctx: {...rec.ctx, getSectionInfo: () => info}, info});
      });
      await bad('missingCalloutMappingUncovered', f => f.contexts.set(f.callOwner, {ctx: {sourcePath: f.file.path, getSectionInfo: () => null}, info: null}));
      await bad('metadataCalloutWithoutContainerUncovered', f => f.callout.className = 'other');
      await bad('complexBodyConservativelyUncovered', () => {}, {body: ['**强调正文**']});
      await bad('fakeRuleTextUncovered', () => {}, {rule: '--- 实际文本'});
      await bad('ruleMetadataOverlapUncovered', f => f.cache.sections.push({...f.cache.sections[2], type: 'paragraph'}));
      await bad('unsupportedNotGloballyExempted', f => f.cache.sections[1].type = 'unknown');
      await bad('textRenderedAsRuleUncovered', f => {const p = document.createElement('p');p.textContent = '意外文本';f.hrOwner.append(p);});
      await bad('nonSelectorTextBesideHrUncovered', f => f.hrOwner.append('漏测文本'));
      await bad('unmappedNonSelectorTextBesideHrUncovered', f => {f.hrOwner.append('漏测文本');f.contexts.set(f.hrOwner, {ctx: {sourcePath: f.file.path, getSectionInfo: () => null}, info: null});});
      await bad('duplicateCalloutContainersUncovered', f => f.callOwner.append(f.callout.cloneNode(true)));
      await bad('missingPlainParagraphStillUncovered', f => f.root.lastElementChild.replaceChildren());
      f = fixture();f.hrOwner.remove();r = await run(f);
      assert(r.targeting.coverage === 'complete' && r.targeting.scanMethod === 'full', 'verified structural exclusion must not require a text mapping');checks.push('pureRuleWithoutTextGroupFullCoverage');
      f = fixture();const mutateAfterLocalize = f.hooks.inspect;
      f.hooks.inspect = (...args) => {f.content.lastElementChild.remove();return mutateAfterLocalize(...args);};
      r = await run(f, [f.call]);assert(r.targeting.scanMethod === 'visible' && r.targeting.coverage === 'uncovered', 'body lost between localization and scan must fail');checks.push('bodyLostAfterLocalizeUncovered');
      f = fixture();const generatedAfterLocalize = f.hooks.inspect;
      f.hooks.inspect = (...args) => {pseudo(f, '.callout::after{content:"新增未测文字"}');return generatedAfterLocalize(...args);};
      r = await run(f, [f.call]);assert(r.targeting.scanMethod === 'visible' && r.targeting.coverage === 'uncovered' && r.targeting.targets[0].reasons.some(s => s.includes('::after')), 'generated text added after localization falsely covered');checks.push('generatedTextAfterLocalizeUncovered');
      f = fixture({height: 110});r = await run(f);
      assert(r.targeting.scanMethod === 'full' && r.scan.complete && r.targeting.coverage === 'complete' && r.blocks.length === 3, 'full fallback must measure all native callout paragraphs');checks.push('oversizedNoteFullCoverage');
      f = fixture();r = await run(f, [f.call, f.rule]);
      assert(r.targeting.scanMethod === 'full' && r.scan.complete && r.targeting.targets[0].coverage === 'complete' && r.targeting.targets[1].coverage === 'uncovered' && r.targeting.coverage === 'uncovered', 'structural-only target must not be falsely clear');checks.push('dualTargetStructuralOnlyNotClear');
      f = fixture();r = await run(f, [f.call, {kind: 'lines', startLine: f.rule.endLine + 2, endLine: f.rule.endLine + 2}]);
      assert(r.targeting.scanMethod === 'full' && r.targeting.coverage === 'complete' && r.targeting.targets.every(t => t.coverage === 'complete'), 'two text targets must use full coverage');checks.push('dualTextTargetFullCoverage');
      f = fixture();pseudo(f, '.callout-icon::after{content:"隐藏图标文字"}.callout::before{content:"可见未测文字"}');
      r = await run(f, [f.call, {kind: 'lines', startLine: f.rule.endLine + 2, endLine: f.rule.endLine + 2}]);
      assert(r.scan.complete && r.targeting.scanMethod === 'full' && r.targeting.targets[0].coverage === 'uncovered' && r.targeting.targets[1].coverage === 'complete', 'generated text failure must stay independent in full dual-target scan');checks.push('dualTargetsGeneratedTextNotConcealedByFullComplete');
      f = fixture();f.callout.querySelector('.callout-title').style.display = 'block';
      r = await run(f, [f.call, {kind: 'lines', startLine: f.rule.endLine + 2, endLine: f.rule.endLine + 2}]);
      assert(r.targeting.coverage === 'uncovered' && r.targeting.targets[0].coverage === 'uncovered' && r.targeting.targets[1].coverage === 'complete', 'one bad callout target must not pass with a good adjacent target');checks.push('dualTargetsKeepIndependentFailures');
      f = fixture();const original = f.hooks.inspect;
      // Simulate a body node that collect did not successfully measure.
      f.hooks.inspect = async (view, plugin, full, observe) => original(view, plugin, full, (root, result) => observe(root, {...result, blocks: result.blocks.filter(b => b.text !== '第二段正文')}));
      r = await run(f);assert(r.targeting.coverage === 'uncovered', 'body node without successful measurement must fail');checks.push('bodyMeasurementOmittedUncovered');
      f = fixture({height: 110});f.content.lastElementChild.remove();r = await run(f);
      assert(r.scan.complete && r.targeting.coverage === 'uncovered', 'legacy full complete cannot conceal a missing callout paragraph');checks.push('fullCompleteDoesNotConcealBodyGap');
      f = fixture({height: 110});const incompleteFull = f.hooks.inspect;
      f.hooks.inspect = async (...args) => {const report = await incompleteFull(...args);report.scan.complete = false;return report;};
      r = await run(f);assert(r.documentCoverage === 'incomplete' && r.targeting.coverage === 'complete', 'complete target evidence must stay independent of document coverage');checks.push('completeCalloutIndependentOfDocumentCoverage');
      const pos = line => ({start: {line}, end: {line}});
      for (const [name, source, line, extra] of [
        ['fencedFakeRule', '```\n***\n```', 1, []],
        ['frontmatterFakeRule', '---\n***\n---', 1, []],
        ['setextFakeRule', 'Title\n---', 1, []],
        ['quotedFakeRule', '> ***', 0, []],
        ['indentedCodeFakeRule', '    ***', 0, []],
        ['overlapFakeRule', '\n***', 1, [{type: 'code', position: {start: {line: 0}, end: {line: 1}}}]]
      ]) {
        const targets = window.targetModule.resolveTargets([{kind: 'lines', startLine: line + 1, endLine: line + 1}], source, {sections: [{type: 'thematicBreak', position: pos(line)}, ...extra]});
        assert(!targets[0].expected.some(s => s.textCoverage === 'excluded'), name + ' wrongly exempted');checks.push(name);
      }
      for (const rule of ['***', '_ _ _', '- - -', '  * * *\t']) {
        f = fixture({rule});r = await run(f);assert(r.targeting.coverage === 'complete', 'valid generic rule rejected: ' + rule);
      }
      checks.push('genericRuleForms');
      return checks;
    });
    console.log(JSON.stringify({passed: checks.length, checks}, null, 2));
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exit(1);});
