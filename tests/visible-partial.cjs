// Real browser geometry; synthetic source/Obsidian APIs. No note writes.
// list-bullet CSS below reproduces installed Obsidian app.css rules: floated
// empty span, U+200B marker/pseudos and a painted circle; runtime still verifies it.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();
    await page.setContent('<style>body{margin:8px}p{font:16px sans-serif;width:120px;line-height:24px;margin:6px 0}li{font:16px sans-serif;width:120px;line-height:24px;margin:6px 0}pre{width:120px}td{padding:5px}.obsidian-list li{position:relative}.obsidian-list{list-style-type:\"\\200B\"}.obsidian-list>li>.list-bullet{color:transparent;position:relative;display:inline-flex;float:left;margin-inline-start:-0.8em;justify-content:center;align-items:center}.list-bullet:before{content:\"\\200B\"}.list-bullet:after{position:absolute;content:\"\\200B\";pointer-events:none;width:5px;height:5px;border-radius:50%;background:#888}</style>');
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
        if(options.list){
          const items=['短项一','短项二','短项三','短项四',suspect];
          parts.push({type:'list',source:items.map(x=>'- '+x).join('\n'),html:'<ul'+(options.obsidian?' class="obsidian-list"':'')+'>'+items.map(x=>'<li>'+(options.obsidian?'<span class="list-bullet"></span>':'')+x+'</li>').join('')+'</ul>'});
        }
        if(!options.codeOnly&&!options.list)parts.push({type:'paragraph',source:options.clear?'短段落':suspect,html:`<p>${options.clear?'短段落':suspect}</p>`});
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
        if(options.decorationBad){
          const bullet=root.querySelector('li:last-child > .list-bullet');
          if(options.decorationBad==='text')bullet.textContent='未测正文';
          if(options.decorationBad==='control')bullet.innerHTML='<input type="checkbox">';
          if(options.decorationBad==='overlap')bullet.style.marginInlineStart='0px';
          if(options.decorationBad==='outline')bullet.style.outline='20px solid red';
          if(options.decorationBad==='image')bullet.style.backgroundImage='linear-gradient(red,blue)';
          const pseudoBad={fixed:'position:fixed;left:0;top:0',sticky:'position:sticky',shadow:'text-shadow:20px 0 red',decoration:'text-decoration:underline',translate:'translate:20px',zoom:'zoom:2',lineheight:'height:auto;line-height:1000px',fontsize:'font-size:100px',spacing:'letter-spacing:50px',minsize:'min-width:1000px',maxsize:'max-height:1000px',motion:'offset-path:path(\"M 0 0 L 100 0\")'};
          if(pseudoBad[options.decorationBad]){const style=document.createElement('style');style.textContent='.list-bullet:after{'+pseudoBad[options.decorationBad]+'}';root.append(style);}
          if(options.decorationBad==='static-host'){bullet.style.position='static';const style=document.createElement('style');style.textContent='.list-bullet:after{left:0;top:0}';root.append(style);}
          if(options.decorationBad==='ancestor-zoom')root.style.zoom='2';

          if(options.decorationBad==='pseudo'){const style=document.createElement('style');style.textContent='.list-bullet:after{content:"未测正文"}';root.append(style);}
          if(options.decorationBad==='marker')root.querySelector('ul').style.listStyleType='"未知正文"';
        }
        if(options.listBad){
          const li=options.listBad==='hiddenSibling'?root.querySelector('li'):root.querySelector('li:last-child');
          const extras={hiddenSibling:'<span style="display:none">遗漏</span>',hidden:'<span style="display:none">遗漏</span>',nested:'<ul><li>嵌套</li></ul>',task:'<input type="checkbox">',br:'<br>主动换行',loose:'<p>其他段落</p>'};
          if(options.listBad==='clipped')li.style.cssText='height:10px;overflow:hidden';
          else li.insertAdjacentHTML('beforeend',extras[options.listBad]);
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
        out.push({name,source,report,confirmed:confirmed.length,writes,calls});return report;
      }
      await run('list-normal',{list:true});
      await run('list-obsidian',{list:true,obsidian:true});
      await run('list-obsidian-table',{list:true,obsidian:true,table:true});
      for(const decorationBad of ['text','control','overlap','outline','image','pseudo','marker','fixed','sticky','shadow','decoration','translate','zoom','static-host','ancestor-zoom','lineheight','fontsize','spacing','minsize','maxsize','motion'])await run('list-decoration-'+decorationBad,{list:true,obsidian:true,decorationBad});
      for(const listBad of ['hidden','hiddenSibling','clipped','nested','task','br','loose'])await run('list-'+listBad,{list:true,listBad});
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
      if(r.name.startsWith('list-')){
        if(['list-normal','list-obsidian','list-obsidian-table'].includes(r.name)){
          assert.ok(report.blocks.every(b=>b.capture.eligibleForEdit===b.suspected),r.name+': only trusted suspects editable');
          const candidate=report.blocks.find(b=>b.capture.eligibleForEdit);
          assert.deepEqual(candidate.capture.editTarget,{kind:'list-item',startLine:5,endLine:5,text:'- '+('测试'.repeat(7)+'测'),itemIndex:4});
          assert.equal(report.visibleCoverage,r.name==='list-obsidian-table'?'uncovered':'complete');
          assert.equal(report.blocks.length,5);
          assert.equal(report.capturedTargets.length,r.name==='list-obsidian-table'?2:1);
          assert.equal(report.capturedTargets[0].coverage,'complete');
          assert.equal(r.confirmed,1,'five-item list must retain the actual short tail');
          assert.ok(report.blocks.every(b=>b.capture.coverage==='complete'&&b.measurementUnit.complete));
          assert.equal(new Set(report.blocks.map(b=>b.key)).size,5);
        }else{
          assert.ok(report.blocks.every(b=>!b.capture.eligibleForEdit),r.name+': incomplete lists never editable');
          assert.equal(r.confirmed,0,r.name+': incomplete LI must not confirm');
          assert.equal(report.visibleCoverage,'uncovered',r.name+': incomplete LI prevents viewport completeness');
          if(r.name!=='list-loose')assert.ok(report.visibleReasons.includes('列表项测量完整性无法确认'));
        }
        continue;
      }
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
    // Feed actual browser-produced captures to the real Python consumer too.
    const accepted=require('node:child_process').spawnSync('python3',['-B',path.join(__dirname,'verify-visible-contract.py')],{input:JSON.stringify(results),encoding:'utf8'});
    assert.equal(accepted.status,0,accepted.stderr);console.log(accepted.stdout);
    console.log(JSON.stringify({passed:results.length,checks:results.map(r=>({name:r.name,visibleCoverage:r.report.visibleCoverage,confirmedSuspects:r.confirmed,calls:r.calls,writes:r.writes,visibleReasons:r.report.visibleReasons}))},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
