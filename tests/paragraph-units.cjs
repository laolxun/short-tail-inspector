// Synthetic sources/metadata/DOM only; real headless character geometry.
const fs=require('node:fs'), path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();
    await page.setContent('<style>body{margin:8px}p{font:16px sans-serif;line-height:24px;width:140px}blockquote{margin-left:16px}.callout-title{display:none}.callout-content{padding:4px}</style>');
    const scanner=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8').split('class ResultModal')[0].split('\n').slice(1).join('\n');
    await page.addScriptTag({content:scanner+'\nwindow.scanner={paragraphUnit,collect,measure,sectionFor,elementPath,SELECTOR,settleLayout,refreshReading,inspect,LayoutContexts};'});
    await page.addScriptTag({content:'{const module={exports:{}};\n'+fs.readFileSync(path.join(__dirname,'../target-scan.js'),'utf8')+'\nwindow.targets=module.exports;}'});
    const checks=await page.evaluate(async()=>{
      window.require=()=>({createHash:()=>({update(){return this;},digest:()=> 'fixture-sha'})});
      const checks=[],assert=(ok,name)=>{if(!ok)throw Error(name);checks.push(name);};
      function fixture(source,html,type='paragraph',height=700){
        document.querySelector('#fixture')?.remove();const container=document.createElement('div');container.id='fixture';document.body.append(container);
        const root=document.createElement('div');root.className='markdown-preview-view';root.style.cssText=`width:260px;height:${height}px;overflow:auto`;container.append(root);
        const owner=document.createElement('div');owner.innerHTML=html;root.append(owner);
        const end=source.split('\n').length-1,file={path:'synthetic.md',stat:{mtime:1}},contexts=new window.scanner.LayoutContexts();
        const info={lineStart:0,lineEnd:end,text:source};contexts.set(owner,{ctx:{sourcePath:file.path,getSectionInfo:()=>info},info});
        const cache={sections:[{type,position:{start:{line:0},end:{line:end}}}]};
        const plugin={contexts,cancelled:false,app:{vault:{read:async()=>source},metadataCache:{getFileCache:()=>cache}}};
        const view={containerEl:container,file,getMode:()=> 'preview',previewMode:{get:()=>source,getScroll:()=>root.scrollTop,rerender(){},applyScroll:n=>{root.scrollTop=n;}}};
        const target={kind:'lines',startLine:1,endLine:end+1,text:source};
        return {root,owner,file,source,cache,contexts,plugin,view,target};
      }
      const run=f=>window.targets.scanTargets(f.view,f.plugin,[f.target],f.source,{...window.scanner});
      const text='正文用于核对完整段落与自动折行'.repeat(3);
      for(const [name,source,html,type] of [
        ['ordinary',text,`<p>${text}</p>`,'paragraph'],
        ['softBreak','第一行源码\n第二行源码','<p>第一行源码\n第二行源码</p>','paragraph'],
        ['quote1',`> ${text}`,`<blockquote><p>${text}</p></blockquote>`,'blockquote'],
        ['quote2',`> > ${text}`,`<blockquote><blockquote><p>${text}</p></blockquote></blockquote>`,'blockquote'],
        ['listIndependent',`- 引导\n\n  ${text}`,`<ul><li><p>引导</p><p>${text}</p></li></ul>`,'list'],
        ['twoQuoteParagraphs','> 第一段\n>\n> 第二段','<blockquote><p>第一段</p><p>第二段</p></blockquote>','blockquote'],
        ['twoCalloutParagraphs','> [!note]\n> 第一段\n>\n> 第二段','<div class="callout"><div class="callout-title">Note</div><div class="callout-content"><p>第一段</p><p>第二段</p></div></div>','callout']
      ]){
        const f=fixture(source,html,type),r=await run(f);
        assert(r.targeting.coverage==='complete' && r.blocks.every(b=>b.measurementUnit.type==='paragraph' && b.measurementUnit.complete),name+'CompleteUnits');
        assert(new Set(r.blocks.map(b=>b.key)).size===r.blocks.length,name+'UniqueKeys');
        if(name.startsWith('two'))assert(r.blocks.length===2 && r.blocks[0].measurementUnit.text!==r.blocks[1].measurementUnit.text,name+'NotMerged');
        if(name==='listIndependent')assert(r.blocks.length===2 && r.blocks[1].measurementUnit.text===text,'listOwnParagraphNotWholeLi');
      }
      let f=fixture('第一行  \n第二行','<p>第一行<br>第二行</p>'),r=await run(f);
      assert(r.blocks[0].measurementUnit.text==='第一行\n第二行' && r.blocks[0].manualBreakCount===1 && !r.blocks[0].suspected,'hardBreakIdentityAndGeometry');
      f=fixture(text,`<p>${text}</p>`,'paragraph',80);r=await run(f);
      assert(r.targeting.scanMethod==='full' && r.targeting.coverage==='complete' && r.blocks[0].measurementUnit.complete,'oversizedFullUnit');
      f=fixture('> 同文\n>\n> 同文','<blockquote><p>同文</p><p>同文</p></blockquote>','blockquote');r=await run(f);
      assert(r.blocks.length===2 && r.blocks[0].key!==r.blocks[1].key && r.blocks[0].measurementUnit.text===r.blocks[1].measurementUnit.text,'duplicateTextRetainsTwoIdentities');
      for(const [name,html,css] of [
        ['hiddenCharacter','<p>正文<span style="display:none">遗漏</span></p>',''],
        ['hiddenVisibility','<p>正文<span style="visibility:hidden">遗漏</span></p>',''],
        ['transparent','<p style="opacity:0">正文</p>',''],
        ['internalClip','<p>正文<span style="display:inline-block;width:1px;overflow:hidden">裁切文字</span></p>',''],
        ['generatedText','<p>正文</p>','.probe::after{content:"未测文字"}'],
        ['generatedUnknown','<p>正文</p>','.probe::before{content:counter(test)}'],
        ['blockSpan','<p>甲<span style="display:block">乙</span></p>',''],
        ['embedded','<p>正文<span class="markdown-embed">嵌入</span></p>',''],
        ['uiText','<p>正文<button>漏测</button></p>','']
      ]){
        f=fixture('source',html);const p=f.owner.querySelector('p');p.classList.add('probe');
        const style=document.createElement('style');style.textContent=css;f.owner.append(style);
        const unit=window.scanner.paragraphUnit(p);assert(unit.complete===false && unit.reasons.length,name+'UnitRejected');
      }
      f=fixture('正文','<p>正文<span style="display:none"></span></p>');
      assert(window.scanner.paragraphUnit(f.owner.querySelector('p')).complete,'emptyHiddenSpanNotTextGap');
      assert(!window.scanner.paragraphUnit(f.owner.querySelector('p'),'仅测了片段').complete,'unitTextMustMatchCompleteMeasurement');
      f=fixture('- 甲\n- 乙','<ul><li>甲<ul><li>乙</li></ul></li></ul>','list');r=await run(f);
      assert(r.blocks.every(b=>b.measurementUnit.type==='list-item-text') && !r.blocks[0].text.includes('乙'),'tightListNotClaimedParagraph');
      f=fixture('```\n代码\n```','<pre><code>代码</code></pre>','code');r=await run(f);
      assert(window.scanner.paragraphUnit(f.owner.querySelector('pre')).type==='code-block','codeNotBodyParagraph');
      assert(!r.blocks.length && r.skipped.length===1 && r.skipped[0].kind==='代码块' && r.targeting.result==='uncovered','protectedCodeSkippedAndTargetNotClear');
      f=fixture('> 第一段\n>\n> 第二段','<blockquote><p>第一段</p><p>第二段</p></blockquote>','blockquote');
      f.target.endLine=1;f.target.text='> 第一段';r=await run(f);assert(r.targeting.coverage==='uncovered','partialMultiParagraphContainerRejected');
      f=fixture('正文','<p>正文</p>');f.contexts.clear();r=await run(f);assert(r.targeting.coverage==='uncovered','missingMappingNotUnitCoverage');
      // Coarse list ownership cannot prove a nested Callout source header/body.
      f=fixture('- 引导\n\n  > [!K]\n  > 正文','<ul><li><p>引导</p><div class="callout"><div class="callout-title">K</div><div class="callout-content"><p>正文</p></div></div></li></ul>','list');
      r=await run(f);assert(r.targeting.coverage==='complete'&&r.blocks.length===2&&r.blocks.every(b=>b.measurementUnit.complete),'sourceListAndDomProveNestedCalloutWithoutTextGuessing');
      // A separate trusted Callout child metadata range must retain its own
      // source identity while remaining inside the verified parent list.
      const child=f.owner.querySelector('.callout'),info={lineStart:2,lineEnd:3,text:f.source};
      f.contexts.set(child,{ctx:{sourcePath:f.file.path,getSectionInfo:()=>info},info});
      f.cache.sections.push({type:'callout',position:{start:{line:2},end:{line:3}}});
      r=await run(f);assert(r.targeting.coverage==='complete' && r.blocks.length===2 && r.blocks.every(b=>b.measurementUnit.complete),'preciseNestedCalloutContextsPermitIndependentUnits');
      return checks;
    });
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
