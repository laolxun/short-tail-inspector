// Synthetic browser geometry only; no screenshots or Vault access.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();
    await page.setContent('<style>.markdown-preview-view{width:360px;height:150px;overflow:auto;transition:width 80ms linear}p{font:16px sans-serif;line-height:24px}</style><div id="container"><div class="markdown-preview-view"><div class="markdown-preview-sizer">'+Array.from({length:20},()=>'<div><p>合成段落用于验证收栏后的扫描和恢复位置，真实笔记不会参与此测试。</p></div>').join('')+'</div></div></div>');
    await page.evaluate(()=>{
      window.modals=[];window.notices=[];
      window.MarkdownViewFixture=class {};
      window.module={exports:{}};
      HTMLElement.prototype.createEl=function(tag,options){const el=document.createElement(tag);el.textContent=options?.text||'';this.appendChild(el);return el;};
      window.require=name=>{
        if(name==='crypto')return {createHash:()=>({update(){return this;},digest(){return 'a'.repeat(64);}})};
        if(name!=='obsidian')throw Error('unexpected module '+name);
        return {Plugin:class {},MarkdownView:window.MarkdownViewFixture,
          Notice:class {constructor(text){window.notices.push(text);}},
          Modal:class {constructor(){this.contentEl=document.createElement('div');}open(){window.modals.push(this);this.onOpen();}}};
      };
    });
    await page.addScriptTag({content:fs.readFileSync(require.resolve('../main.js'),'utf8')+'\nwindow.LayoutContextsFixture=LayoutContexts;window.inspectFixture=inspect;window.settleLayoutFixture=settleLayout;'});
    await page.addScriptTag({content:'{const module={exports:{}};'+fs.readFileSync(require.resolve('../target-scan.js'),'utf8')+';window.targetFixture=module.exports;}'});
    const checks=await page.evaluate(async()=>{
      const root=document.querySelector('.markdown-preview-view'),source=Array.from({length:20},()=> '合成段落').join('\n');
      const view=new window.MarkdownViewFixture();
      Object.assign(view,{file:{path:'synthetic.md',stat:{mtime:1}},getMode:()=> 'preview',containerEl:document.getElementById('container'),
        previewMode:{get:()=>source,getScroll:()=>root.scrollTop,rerender(){},applyScroll:n=>{root.scrollTop=n;}}});
      view.leaf={view};
      const resize=()=>{root.style.width=(360+60*Number(left.collapsed)+60*Number(right.collapsed))+'px';};
      const dock=()=>({collapsed:false,collapse(){this.collapsed=true;resize();},expand(){this.collapsed=false;resize();}});
      const left=dock(),right=dock(),saved=[];
      const plugin=new window.module.exports();
      Object.assign(plugin,{busy:false,cancelled:false,contexts:new window.LayoutContextsFixture(),
        app:{workspace:{getActiveViewOfType:()=>view,leftSplit:left,rightSplit:right},vault:{read:async()=>source},metadataCache:{getFileCache:()=>({sections:Array.from({length:20},(_,i)=>({type:'paragraph',position:{start:{line:i},end:{line:i}}}))})}},
        save:async report=>{saved.push(report);}});
      root.querySelectorAll('p').forEach((p,i)=>plugin.contexts.set(p.parentElement,{ctx:{sourcePath:view.file.path,getSectionInfo:()=>({lineStart:i,lineEnd:i,text:source})},info:{lineStart:i,lineEnd:i,text:source}}));
      let checked=0;
      for(const full of [false,true])for(const exportReport of [false,true]){
        root.scrollTop=17;window.modals.length=0;window.notices.length=0;saved.length=0;
        await plugin.run(exportReport,full);
        if(window.modals.length!==1 || saved.length!==Number(exportReport))throw Error('manual scan/save behavior failed');
        const report=window.modals[0].report;
        if(report.viewportWidthPx!==480 || report.scan.full!==full)throw Error('scan used width before sidebar animations settled');
        if(full && (!report.scan.complete || report.blocks.length!==20))throw Error('full scan coverage failed');
        if(root.scrollTop!==17 || root.clientWidth!==360 || left.collapsed || right.collapsed || plugin.busy)throw Error('manual layout restoration failed');
        checked++;
      }
      // Inject a real width change after the first measured viewport.
      root.scrollTop=17;window.modals.length=0;window.notices.length=0;saved.length=0;
      inspect=(v,p,full)=>window.inspectFixture(v,p,full,()=>{root.style.transition='none';root.style.width='300px';});
      await plugin.run(true,true);
      if(!window.notices.some(n=>n.includes('阅读宽度发生变化')) || saved.length || window.modals.length)throw Error('actual scan width change was not rejected');
      if(root.scrollTop!==17 || root.clientWidth!==360 || left.collapsed || right.collapsed || plugin.busy)throw Error('width failure recovery failed');
      const files=new Map();plugin.manifest={dir:'plugin'};
      plugin.app.vault.adapter={exists:async p=>files.has(p),read:async p=>files.get(p),write:async(p,v)=>files.set(p,v)};
      plugin.app.workspace.getLeavesOfType=()=>[view.leaf];
      Object.assign(view.leaf,{getViewState:()=>({state:{mode:'preview'}}),getEphemeralState:()=>({}),setEphemeralState(){}});
      plugin.runtimeModule=()=>window.targetFixture;
      const scans=[];
      for(const fail of [false,true]){
        root.scrollTop=17;saved.length=0;
        inspect=(...args)=>{scans.push(args[2]);if(fail)throw Error('injected viewport failure');return window.inspectFixture(...args);};
        files.set('plugin/request.json',JSON.stringify({schemaVersion:3,action:'scan',id:'visible-'+fail,file:view.file.path,expectedSourceSha256:'a'.repeat(64),scanMode:'visible',localOnly:false,temporaryReadingLayout:true,expiresAt:Date.now()+30000}));
        // save() stays in memory; no filesystem or report cleanup in this fixture.
        plugin.save=async report=>{saved.push(report);return {report:{archivePath:'plugin/reports/synthetic.json'},cleanup:{warnings:[]}};};
        await plugin.pollRequest();
        const response=JSON.parse(files.get('plugin/response.json'));
        if(response.status!==(fail?'error':'incomplete'))throw Error('viewport request status '+JSON.stringify(response));
        if(!fail && (saved[0].scan.steps!==1 || saved[0].layout.contentWidthPx!==480 || saved[0].scan.full))throw Error('viewport scan must measure once after animated resize');
        if(root.scrollTop!==17 || left.collapsed || right.collapsed || root.clientWidth!==360 || plugin.busy)throw Error('viewport request restoration failed');
      }
      if(scans.length!==2 || scans.some(Boolean))throw Error('viewport request started full scan');
      return {checks:checked+3,visibleRequestChecks:2,animatedSidebarScans:checked,actualWidthGuard:true,scrollRestored:true};
    });
    console.log(JSON.stringify(checks,null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
