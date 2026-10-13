// Current DOM geometry with synthetic Obsidian API responses; no Vault writes.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<style>p{width:120px;font:16px sans-serif;line-height:24px}</style>');
    const scanner = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
      .split('class ResultModal')[0].split('\n').slice(1).join('\n');
    await page.addScriptTag({content: scanner + '\nwindow.scanner={sourceMappingFor,sectionFor,collect,LayoutContexts};'});
    const checks = await page.evaluate(() => {
      const checks = [], assert = (ok, message) => {if (!ok) throw new Error(message);};
      const source = '第一段\n\n' + '测试'.repeat(7) + '测';
      const good = {lineStart: 2, lineEnd: 2, text: source};
      function fixture() {
        document.querySelector('#fixture')?.remove();
        const root = document.createElement('div');root.id = 'fixture';root.className = 'markdown-preview-view';
        root.style.cssText = 'width:180px;height:300px;overflow:auto';document.body.append(root);
        const owner = document.createElement('div'), p = document.createElement('p');
        p.textContent = '测试'.repeat(7) + '测';owner.append(p);root.append(owner);
        return {root, owner, p, contexts: new window.scanner.LayoutContexts()};
      }
      const record = (info, live = info, file = 'fixture.md') => ({info:info?{...info}:null,
        ctx: {sourcePath: file, getSectionInfo: typeof live === 'function' ? live : () => live}});
      const locate = f => window.scanner.sourceMappingFor(f.p, f.contexts, source, {root: f.root, filePath: 'fixture.md'});
      let f = fixture();f.contexts.set(f.owner, record({...good, text: 'old source'}, good));
      let r = locate(f);
      assert(r.section?.start === 2 && r.basis === 'live', 'fresh API must survive a stale cached version');
      checks.push('freshLiveInfoOverridesStaleCache');
      f = fixture();f.contexts.set(f.owner, record(null, good));
      assert(locate(f).section?.start === 2, 'fresh API must recover initially missing registration info');
      checks.push('initialNullCacheRecovered');
      f = fixture();f.contexts.set(f.p, record({...good, text: 'old source'}));f.contexts.set(f.owner, record(good));
      r = locate(f);
      assert(r.section?.owner === f.owner && r.failures[0].reason === 'source-version-mismatch', 'stale child must not hide a trusted ancestor');
      checks.push('staleChildFallsBackToTrustedAncestor');
      f = fixture();f.contexts.set(f.p, record(good, () => {throw Error('API unavailable');}));f.contexts.set(f.owner, record(good));
      r = locate(f);
      assert(r.section?.owner === f.owner && r.failures[0].reason === 'section-api-error', 'API error must permit another trusted ancestor');
      checks.push('apiErrorFallsBackToTrustedAncestor');
      f = fixture();f.contexts.set(f.p, record(good, good, 'other.md'));f.contexts.set(f.owner, record(good));
      r = locate(f);
      assert(r.section?.sourcePath === 'fixture.md' && r.failures[0].reason === 'source-path-mismatch', 'foreign context must not replace note identity');
      checks.push('foreignChildFallsBackToCorrectFile');
      for (const info of [{...good, lineStart: -1}, {...good, lineEnd: 3}, {...good, lineStart: true},
        {...good, lineStart: 2.5}, {...good, lineStart: 2, lineEnd: 1}, {...good, text: undefined}]) {
        f = fixture();f.contexts.set(f.owner, record(info));r = locate(f);
        assert(!r.section && r.failures.length, 'invalid range or absent version must remain unmapped');
      }
      checks.push('invalidRangesAndMissingVersionsRejected');
      f = fixture();f.contexts.set(f.owner, record(good, el => el === f.p ? good : {...good, lineStart: 0, lineEnd: 0}));
      r = locate(f);assert(!r.section && r.failures[0].reason === 'owner-range-mismatch', 'child/owner range mismatch must fail');
      checks.push('ownerRangeMismatchRejected');
      f = fixture();f.contexts.set(f.owner, record(good, null));r = locate(f);
      assert(r.section?.start === 2 && r.basis === 'registered-snapshot', 'unchanged registered owner may use a verified snapshot');
      checks.push('stableRegisteredSnapshotAccepted');
      f = fixture();f.contexts.set(f.owner, record(good, null));f.root.prepend(document.createElement('div'));r = locate(f);
      assert(!r.section && r.failures[0].reason === 'cached-owner-unverified', 'moved cached owner must not retain its old range');
      checks.push('movedCachedOwnerRejected');
      f = fixture();f.contexts.set(f.owner, record(good, null));f.p.append('changed');
      assert(!locate(f).section, 'changed owner text must invalidate cached attribution');checks.push('changedCachedOwnerRejected');
      f = fixture();f.contexts.set(f.owner, record(good, null));f.contexts.get(f.owner).info.lineStart = 0;
      assert(!locate(f).section, 'modified snapshot bounds must not be accepted');checks.push('modifiedCacheRejected');
      f = fixture();f.contexts.set(f.owner, record(good));f.owner.remove();
      assert(locate(f).reason === 'detached-node', 'detached owner must fail');checks.push('detachedOwnerRejected');
      f = fixture();f.contexts.set(document.body, record(good));
      assert(!locate(f).section, 'context outside reading view must not assign source lines');checks.push('outsideRootOwnerRejected');
      f = fixture();let result = window.scanner.collect(f.root, f.contexts, source.split('\n'), 'fixture.md');
      let b = result.blocks[0];
      assert(b.suspected && b.sourceStartLine === null && b.sourceEndLine === null && b.domPath === null && b.key === null,
        'unmapped text may be measured but must not guess source positions');
      assert(b.renderDomPath === '0.0' && b.sourceMapping.reason === 'context-missing', 'unmapped block needs independent DOM evidence and failure reason');
      assert(JSON.stringify(result), 'mapping diagnostics must serialize without DOM references');checks.push('unmappedSuspectKeepsIndependentDomPath');
      f.contexts.set(f.owner, record({...good, text: 'old source'}, good));
      result = window.scanner.collect(f.root, f.contexts, source.split('\n'), 'fixture.md');b = result.blocks[0];
      assert(b.sourceStartLine === 3 && b.sourceEndLine === 3 && b.domPath === '0' && b.key === '2:2:0' &&
        b.renderDomPath === '0.0' && result.ranges.some(([a, end]) => a === 2 && end === 2), 'mapped path/key semantics or live range collection changed');
      checks.push('mappedDomPathSemanticsUnchanged');
      f = fixture();f.contexts.set(f.owner, record({...good, text: 'old source'}));
      result = window.scanner.collect(f.root, f.contexts, source.split('\n'), 'fixture.md');
      assert(result.ranges.length === 0 && result.blocks[0].sourceMapping.failures[0].reason === 'source-version-mismatch',
        'stale versions must not enter coverage ranges');checks.push('staleRangeExcludedFromCoverage');
      f = fixture();f.owner.innerHTML = '<pre><code>protected code</code></pre>';
      result = window.scanner.collect(f.root, f.contexts, source.split('\n'), 'fixture.md');
      assert(!result.blocks.length && result.skipped[0].kind === '代码块' && result.skipped[0].sourceMapping.status === 'unmapped' &&
        result.skipped[0].renderDomPath === '0.0', 'normal code skip and mapping failure must be distinct');
      checks.push('codeSkipPreservesMappingDiagnosis');
      return checks;
    });
    console.log(JSON.stringify({passed: checks.length, checks}, null, 2));
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exit(1);});
