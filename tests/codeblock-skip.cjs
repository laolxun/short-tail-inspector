// Synthetic Obsidian contexts; real browser geometry. No Vault or deployment.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<style>p,pre{width:120px;font:16px sans-serif;line-height:24px}pre{white-space:pre-wrap}code{font:inherit}</style>');
    const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
      .split('class ResultModal')[0].split('\n').slice(1).join('\n');
    await page.addScriptTag({content: source + `
      const originalMeasure = measure;
      window.codeMeasureCalls = 0;
      measure = (el, options = {}) => {
        if (options.code || el.closest('pre')) window.codeMeasureCalls++;
        return originalMeasure(el, options);
      };
      window.scanner = {inspect, collect, LayoutContexts, sectionFor, elementPath,
        SELECTOR, settleLayout, refreshReading};`});
    await page.addScriptTag({content: '{const module={exports:{}};\n' +
      fs.readFileSync(path.join(__dirname, '../target-scan.js'), 'utf8') +
      '\nwindow.targetModule=module.exports;}'});
    const checks = await page.evaluate(async () => {
      window.require = () => ({createHash: () => ({update() {return this;}, digest: () => 'fixture-hash'})});
      const checks = [], assert = (ok, message) => {if (!ok) throw new Error(message);};
      function fixture(language, body = 'systemctl enable --now firewalld\nfirewall-cmd --list-all', withParagraph = true) {
        document.querySelector('#fixture')?.remove();
        const container = document.createElement('div');container.id = 'fixture';document.body.append(container);
        const root = document.createElement('div');root.className = 'markdown-preview-view';
        root.style.cssText = 'width:180px;height:600px;overflow:auto';container.append(root);
        const pre = document.createElement('pre'), code = document.createElement('code');
        if (language) code.className = 'language-' + language;
        code.textContent = body;pre.append(code);root.append(pre);
        const text = '测试'.repeat(7) + '测', codeEnd = body.split('\n').length + 1;
        const lines = ['```' + language, ...body.split('\n'), '```'];
        const owners = [pre], sections = [{type: 'code', position: {start: {line: 0}, end: {line: codeEnd}}}];
        if (withParagraph) {
          lines.push('', text);
          const p = document.createElement('p');p.textContent = text;root.append(p);owners.push(p);
          sections.push({type: 'paragraph', position: {start: {line: codeEnd + 2}, end: {line: codeEnd + 2}}});
        }
        const source = lines.join('\n'), file = {path: 'code-skip.md', stat: {mtime: 1}};
        const contexts = new window.scanner.LayoutContexts();
        owners.forEach((owner, i) => {
          const info = {lineStart: sections[i].position.start.line, lineEnd: sections[i].position.end.line, text: source};
          contexts.set(owner, {ctx: {sourcePath: file.path, getSectionInfo: () => info}, info});
        });
        const plugin = {contexts, cancelled: false, app: {vault: {read: async () => source},
          metadataCache: {getFileCache: () => ({sections})}}};
        const view = {containerEl: container, file, getMode: () => 'preview', previewMode: {
          get: () => source, getScroll: () => root.scrollTop, rerender() {}, applyScroll: n => {root.scrollTop = n;}}};
        return {root, source, codeEnd, plugin, view, file};
      }
      for (const language of ['bash', '', 'python']) for (const full of [false, true]) {
        const f = fixture(language), before = window.codeMeasureCalls;
        const r = await window.scanner.inspect(f.view, f.plugin, full);
        assert(window.codeMeasureCalls === before, 'PRE must never reach character measurement');
        assert(r.blocks.length === 1 && r.blocks[0].suspected && r.blocks[0].kind !== '代码块', 'ordinary paragraph detection changed');
        const skipped = r.skipped;
        assert(skipped.length === 1 && skipped[0].kind === '代码块' && skipped[0].reason.includes('跳过短尾检测'), 'missing skip type/reason');
        assert(skipped[0].sourceStartLine === 1 && skipped[0].sourceEndLine === f.codeEnd + 1 &&
          typeof skipped[0].domPath === 'string' && skipped[0].key, 'missing code position');
        assert(!full || r.scan.complete, 'protected code must not break full traversal');
        checks.push((language || 'unlabelled') + '_' + (full ? 'full' : 'visible'));
      }
      let f = fixture('', 'x'.repeat(13000), false), before = window.codeMeasureCalls;
      const r = window.scanner.collect(f.root, f.plugin.contexts, f.source.split('\n'), f.file.path);
      assert(window.codeMeasureCalls === before && !r.blocks.length && r.skipped.length === 1 &&
        r.skipped[0].reason.includes('跳过短尾检测'), 'long protected code was measured or failed measurement');
      checks.push('longCodeBypassesMeasurement');
      f = fixture('bash', 'systemctl enable --now firewalld', false);
      const targeted = await window.targetModule.scanTargets(f.view, f.plugin,
        [{kind: 'lines', startLine: 1, endLine: f.codeEnd + 1}], f.source, {...window.scanner});
      assert(!targeted.blocks.length && targeted.skipped.length === 1 && targeted.targeting.result === 'uncovered',
        'a skipped-only target must not be reported as measured clear');
      checks.push('codeOnlyTargetRemainsUncovered');
      return checks;
    });
    console.log(JSON.stringify({passed: checks.length, checks}, null, 2));
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exit(1);});
