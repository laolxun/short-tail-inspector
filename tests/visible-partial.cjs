// Real browser geometry; synthetic source/Obsidian APIs. No note writes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();
    await page.setContent('<style>body{margin:8px}p{font:16px sans-serif;width:120px;line-height:24px;margin:6px 0}pre{width:120px}td{padding:5px}</style>');
    const scanner=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8').split('class ResultModal')[0].split('\n').slice(1).join('\n');
    await page.addScriptTag({content:scanner+';window.scanner={sourceMappingFor,sectionFor,elementPath,SELECTOR,settleLayout,refreshReading,inspect,LayoutContexts};'});
    await page.addScriptTag({content:'{const module={exports:{}};'+fs.readFileSync(path.join(__dirname,'../target-scan.js'),'utf8')+';window.targets=module.exports;}'});
    const results=await page.evaluate(async()=>{
      window.require=()=>({createHash:()=>({update(){return this;},digest:()=> 'synthetic-sha'})});
      const out=[],suspect='测试'.repeat(7)+'测';
      async function run(name,options={}){
        document.getElementById('fixture')?.remove();
        const container=document.createElement('div');container.id='fixture';document.body.append(container);
        const root=document.createElement('div');root.className='markdown-preview-view';root.style.cssText='width:300px;height:600px;overflow:auto';container.append(root);
        const parts=[];
        if(!options.codeOnly)parts.push({type:'paragraph',source:options.clear?'短段落':suspect,html:`<p>${options.clear?'短段落':suspect}</p>`});
        if(options.code||options.codeOnly)parts.push({type:'code',source:'```bash\necho protected\n```',html:'<pre><code>echo protected</code></pre>'});
        if(options.table)parts.push({type:'table',source:'| 未测 |\n| --- |\n| 表格 |',html:'<table><tr><td>未测表格</td></tr></table>'});
        const source=parts.map(p=>p.source).join('\n\n'),contexts=new window.scanner.LayoutContexts(),cache={sections:[]},file={path:'fixture.md',stat:{mtime:1}};
        let start=0;
        for(const part of parts){
          const owner=document.createElement('div');owner.innerHTML=part.html;root.append(owner);
          const end=start+part.source.split('\n').length-1,info={lineStart:start,lineEnd:end,text:source};
          contexts.set(owner,{ctx:{sourcePath:file.path,getSectionInfo:()=>info},info:options.cacheOnly?{...info}:info});
          cache.sections.push({type:part.type,position:{start:{line:start},end:{line:end}}});
          start=end+2;
        }
        if(options.missingCache){for(const [,record] of contexts)record.info=null;}
        if(options.staleChild){
          const p=root.querySelector('p'),info={text:'stale',lineStart:0,lineEnd:0};
          contexts.set(p,{ctx:{sourcePath:file.path,getSectionInfo:()=>info},info});
        }
        if(options.stale){for(const [,record] of contexts)record.info.text='stale';}
        if(options.hidden)root.querySelector('p').append(Object.assign(document.createElement('span'),{textContent:'遗漏'}));
        if(options.hidden)root.querySelector('span').style.display='none';
        if(options.clipped)root.querySelector('p').style.cssText+='height:10px;overflow:hidden';
        if(options.measureFailure)root.querySelector('p').textContent='长'.repeat(12001);
        if(options.unknown){const raw=document.createElement('p');raw.textContent='真正未知的可见文本';root.prepend(raw);}
        if(options.unknownCode)contexts.clear();
        let writes=0;const denyWrite=()=>{writes++;throw Error('note write forbidden');};
        const plugin={contexts,cancelled:false,app:{vault:{read:async()=>source,modify:denyWrite,create:denyWrite},metadataCache:{getFileCache:()=>cache}}};
        const view={containerEl:container,file,getMode:()=> 'preview',previewMode:{get:()=>source,getScroll:()=>root.scrollTop,rerender(){throw Error('visible must not rerender');},applyScroll(){throw Error('visible must not scroll');}}};
        const calls=[];const hooks={...window.scanner,inspect:async(...args)=>{calls.push(args[2]);return window.scanner.inspect(...args);}};
        const report=await window.targets.scanVisible(view,plugin,source,hooks);
        if(calls.length!==1||calls[0]!==false||report.scan.steps!==1||report.scan.full||writes||root.scrollTop!==0)throw Error(name+': one-pass/no-write contract');
        const confirmed=report.blocks.filter(b=>b.suspected && b.capture.coverage==='complete');
        out.push({name,report,confirmed:confirmed.length,writes,calls});return report;
      }
      await run('paragraph-and-code',{code:true});
      await run('stale-cache-live-valid',{cacheOnly:true,stale:true});
      await run('missing-cache-live-valid',{cacheOnly:true,missingCache:true});
      await run('stale-child-trusted-ancestor',{staleChild:true});
      await run('paragraph-and-table',{table:true});
      await run('paragraph-and-unknown',{unknown:true});
      await run('no-suspect-with-table',{clear:true,table:true});
      await run('no-suspect-with-unknown',{clear:true,unknown:true});
      await run('hidden-paragraph-with-table',{hidden:true,table:true});
      await run('stale-paragraph-with-table',{stale:true,table:true});
      await run('clipped-paragraph-with-table',{clipped:true,table:true});
      await run('measurement-failed-paragraph',{measureFailure:true});
      await run('protected-code-only',{codeOnly:true});
      await run('unmapped-code-is-not-exclusion',{codeOnly:true,unknownCode:true});
      await run('paragraph-code-table',{code:true,table:true});
      return out;
    });
    for(const r of results){
      const report=r.report;
      if(['paragraph-and-code','protected-code-only','stale-cache-live-valid','missing-cache-live-valid','stale-child-trusted-ancestor'].includes(r.name))assert.equal(report.visibleCoverage,'complete',r.name);
      else assert.equal(report.visibleCoverage,'uncovered',r.name);
      if(['paragraph-and-code','paragraph-and-table','paragraph-and-unknown','paragraph-code-table','stale-cache-live-valid','missing-cache-live-valid','stale-child-trusted-ancestor'].includes(r.name)){
        assert.equal(r.confirmed,1,r.name+': keep trusted suspect');
        const block=report.blocks.find(b=>b.capture.coverage==='complete');
        assert.equal(block.sourceMapping.status,'mapped');assert.ok(block.sourceStartLine>=1);assert.equal(block.measurementUnit.complete,true);
        // The original stricter target gate still denies editing with unknown scope.
        assert.equal(block.capture.eligibleForEdit,r.name!=='paragraph-and-unknown',r.name+': unchanged edit gate');
      }else assert.equal(r.confirmed,0,r.name+': no false confirmed suspect');
      if(r.name==='stale-child-trusted-ancestor'){
        assert.equal(report.blocks[0].sourceMapping.basis,'live');
        assert.equal(report.blocks[0].sourceMapping.failures[0].reason,'source-version-mismatch');
      }
      if(r.name.includes('table'))assert.ok(report.visibleReasons.some(s=>s.includes('表格')),r.name+': table reason');
      if(['paragraph-and-code','protected-code-only','paragraph-code-table'].includes(r.name)){
        const code=report.skipped.find(b=>b.kind==='代码块');assert.equal(code.coverage,'excluded');assert.ok(code.sourceStartLine>=1);assert.ok(code.sourceEndLine>=code.sourceStartLine);
      }
      if(r.name==='paragraph-and-unknown'){
        const gap=report.capturedTargets[0].mappingGaps.find(g=>g.mappingDecision?.decision==='rejected');
        assert.equal(gap.mappingDecision.reason,'context-missing');
        assert.equal(gap.mappingDecision.ownerDomPath,null);
        assert.ok(JSON.stringify(report));
      }
      if(r.name==='unmapped-code-is-not-exclusion')assert.ok(report.skipped.every(b=>b.coverage!=='excluded'));
      if(/hidden|stale-paragraph|clipped|failed/.test(r.name))assert.ok(report.blocks.every(b=>!b.capture.eligibleForEdit && b.capture.coverage!=='complete'));
    }
    console.log(JSON.stringify({passed:results.length,checks:results.map(r=>({name:r.name,visibleCoverage:r.report.visibleCoverage,confirmedSuspects:r.confirmed,calls:r.calls,writes:r.writes,visibleReasons:r.report.visibleReasons}))},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
