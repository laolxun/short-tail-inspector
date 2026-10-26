// Cross-mode contract: real browser geometry, synthetic Obsidian metadata/DOM.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<style>body{margin:8px}p,li{font:16px sans-serif;line-height:24px;width:120px;margin:6px 0}blockquote{margin:0 0 0 8px}.callout-title{display:none}ul{padding-left:20px}</style>');
    const scanner = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').split('class ResultModal')[0].split('\n').slice(1).join('\n');
    await page.addScriptTag({content: scanner + '\nwindow.scanner={collect,measure,paragraphUnit,sectionFor,sourceMappingFor,elementPath,SELECTOR,settleLayout,refreshReading,inspect,LayoutContexts};'});
    await page.addScriptTag({content: '{const module={exports:{}};' + fs.readFileSync(path.join(__dirname, '../target-scan.js'), 'utf8') + ';window.targets=module.exports;}'});
    const results = await page.evaluate(async () => {
      window.require = () => ({createHash: () => ({update() {return this;}, digest: () => 'synthetic-sha'})});
      const text = '测试'.repeat(7) + '测';
      const cases = [
        ['ordinary', text, `<p>${text}</p>`, 'paragraph', true],
        ['soft-break', text.slice(0,7)+'\n'+text.slice(7), `<p>${text.slice(0,7)}\n${text.slice(7)}</p>`, 'paragraph', true],
        ['inline-markup', '**'+text+'**', `<p><strong>${text}</strong></p>`, 'paragraph', true],
        ['quote', '> '+text, `<blockquote><p>${text}</p></blockquote>`, 'blockquote', false],
        ['nested-quote', '> > '+text, `<blockquote><blockquote><p>${text}</p></blockquote></blockquote>`, 'blockquote', false],
        ['callout', '> [!K]\n> '+text, `<div class="callout"><div class="callout-title">K</div><div class="callout-content"><p>${text}</p></div></div>`, 'callout', false],
        ['two-quote-paragraphs', '> '+text+'\n>\n> '+text, `<blockquote><p>${text}</p><p>${text}</p></blockquote>`, 'blockquote', false],
        ['two-callout-paragraphs', '> [!K]\n> '+text+'\n>\n> '+text, `<div class="callout"><div class="callout-title">K</div><div class="callout-content"><p>${text}</p><p>${text}</p></div></div>`, 'callout', false],
        ['tight-list', '- '+text, `<ul><li>${text}</li></ul>`, 'list', false],
        ['loose-list', '- '+text+'\n\n  '+text, `<ul><li><p>${text}</p><p>${text}</p></li></ul>`, 'list', false],
        // A paragraph child label/range alone does not prove standalone ownership.
        ['nested-paragraph-metadata', '> '+text, `<blockquote><p>${text}</p></blockquote>`, 'paragraph', false],
        ['duplicate-independent-paragraphs', text+'\n\n'+text, `<p>${text}</p><p>${text}</p>`, 'paragraph', true, {separateOwners:true}],
        ['stale-child-recovered-by-parent', text, `<p>${text}</p>`, 'paragraph', true, {staleChild:true}],
        ['two-nodes-paragraph-metadata', text+'\n\n'+text, `<p>${text}</p><p>${text}</p>`, 'paragraph', false],
      ];
      const results = [];
      for (const [name, source, html, type, expectedEditable, options={}] of cases) {
        document.getElementById('fixture')?.remove();
        const container=document.createElement('div');container.id='fixture';document.body.append(container);
        const root=document.createElement('div');root.className='markdown-preview-view';root.style.cssText='width:260px;height:800px;overflow:auto';container.append(root);
        const owner=document.createElement('div');owner.innerHTML=html;root.append(owner);
        const file={path:'synthetic.md',stat:{mtime:1}}, contexts=new window.scanner.LayoutContexts();
        const info={lineStart:0,lineEnd:source.split('\n').length-1,text:source};
        const ctx={sourcePath:file.path,getSectionInfo:()=>info};contexts.set(owner,{ctx,info});
        const cache={sections:[{type,position:{start:{line:0},end:{line:info.lineEnd}}}]};
        if(options.separateOwners){
          contexts.clear();cache.sections=[];
          [...owner.children].forEach((p,i)=>{
            const childInfo={lineStart:i*2,lineEnd:i*2,text:source};
            contexts.set(p,{ctx:{sourcePath:file.path,getSectionInfo:()=>childInfo},info:childInfo});
            cache.sections.push({type:'paragraph',position:{start:{line:i*2},end:{line:i*2}}});
          });
        }
        if(options.staleChild){
          const stale={...info,text:'stale'};
          contexts.set(owner.firstElementChild,{ctx:{sourcePath:file.path,getSectionInfo:()=>stale},info:stale});
        }
        const plugin={contexts,cancelled:false,app:{vault:{read:async()=>source},metadataCache:{getFileCache:()=>cache}}};
        const view={containerEl:container,file,getMode:()=> 'preview',previewMode:{get:()=>source,getScroll:()=>root.scrollTop,rerender(){},applyScroll:n=>{root.scrollTop=n;}}};
        const collected=window.scanner.collect(root,contexts,source.split('\n'),file.path);
        const full=await window.scanner.inspect(view,plugin,true);
        const visible=await window.targets.scanVisible(view,plugin,source,window.scanner);
        const evidence=b=>({key:b.key,start:b.sourceStartLine,end:b.sourceEndLine,domPath:b.domPath,renderDomPath:b.renderDomPath,sourceMapping:b.sourceMapping,measurementUnit:b.measurementUnit,text:b.text,suspected:b.suspected,lines:b.lines});
        results.push({name,expectedEditable,full:full.blocks.map(evidence),collected:collected.blocks.map(evidence),visible:visible.blocks.map(evidence),
          actualEditable:visible.blocks.map(b=>b.capture.eligibleForEdit),capture:visible.blocks.map(b=>b.capture),
          fullHasCapture:full.blocks.some(b=>'capture' in b),visibleCoverage:visible.visibleCoverage});
      }
      return results;
    });
    // Print evidence before assertions so a pre-fix failure remains reviewable.
    console.log(JSON.stringify(results.map(r=>({name:r.name,expectedEditable:r.expectedEditable,actualEditable:r.actualEditable,
      ranges:r.full.map(b=>[b.start,b.end]),unitTypes:r.full.map(b=>b.measurementUnit.type),visibleCoverage:r.visibleCoverage})),null,2));
    for(const r of results) {
      assert.deepEqual(r.full,r.collected,r.name+': full uses collect mapping and units');
      assert.deepEqual(r.visible,r.full,r.name+': visible preserves full mapping and measurement');
      assert.equal(r.fullHasCapture,false,r.name+': full never grants edit eligibility');
    }
    for(const r of results) {
      assert.ok(r.full.every(b=>b.suspected),r.name+': fixture exercises actual suspected blocks');
      assert.ok(r.actualEditable.every(v=>v===r.expectedEditable),r.name+': independent Markdown paragraph eligibility');
      assert.ok(r.capture.every(c=>c.eligibleForEdit ? c.editReasons.length===0 : c.editReasons.length>0),r.name+': explicit eligibility evidence');
      if(r.name==='stale-child-recovered-by-parent'){
        assert.equal(r.full[0].sourceMapping.status,'mapped');
        assert.ok(r.full[0].sourceMapping.failures.length>0);
        assert.equal(r.visibleCoverage,'complete','trusted unique parent restores coverage without bypassing paragraph edit gates');
      } else {
        assert.equal(r.visibleCoverage,'complete',r.name+': edit rejection does not change scan coverage');
      }
    }
    console.log(JSON.stringify({passed:results.length,crossModeMappingUnchanged:true}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
