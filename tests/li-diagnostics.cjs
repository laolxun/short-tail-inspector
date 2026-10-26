// Diagnostics only: synthetic DOM/Obsidian APIs with real browser styles.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage();
  await page.setContent('<style>body{margin:8px}li{font:16px sans-serif;line-height:24px;width:140px}.layout{display:flex}.moved{position:relative;transform:translateX(1px)}.clear{color:transparent}.generated::after{content:"PRIVATE_GENERATED_TEXT"}.marker::marker{content:"PRIVATE_MARKER_TEXT"}</style>');
  const scanner=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8').split('class ResultModal')[0].split('\n').slice(1).join('\n');
  await page.addScriptTag({content:scanner+`;const originalUnit=paragraphUnit;paragraphUnit=(el,text)=>originalUnit(el,text,{diagnostics:window.diagnosticsEnabled});window.scanner={paragraphUnit,sourceMappingFor,sectionFor,elementPath,SELECTOR,settleLayout,refreshReading,inspect,LayoutContexts};`});
  await page.addScriptTag({content:'{const module={exports:{}};'+fs.readFileSync(path.join(__dirname,'../target-scan.js'),'utf8')+';window.targets=module.exports;}'});
  const results=await page.evaluate(async()=>{
   window.require=()=>({createHash:()=>({update(){return this;},digest:()=> 'synthetic-sha'})});
   const rows=[];
   for(const [name,html] of [
    ['plain','<li>普通正文</li>'],
    ['styles','<li class="marker"><span class="layout moved clear generated">PRIVATE_NOTE_TEXT</span></li>'],
    ['hidden','<li>正文<span style="display:none">PRIVATE_HIDDEN_TEXT</span></li>'],
    ['clipped','<li>正文<span style="display:inline-block;width:1px;overflow:hidden">裁切正文</span></li>'],
    ['structure','<li>正文<br><button>按钮</button></li>'],
    ['bounded','<li>'+Array.from({length:40},()=>'<span class="'+ 'x'.repeat(400)+'" style="display:block;position:relative">PRIVATE_NOTE_TEXT</span>').join('')+'</li>'],
    ['class-url','<li class="https://example.invalid/PRIVATE_CLASS_URL" style="transform:translateX(1px)">正文</li>'],
    ['marker-string',"<li style=\"list-style-type:'PRIVATE_MARKER_STRING'\">正文</li>"],
    ['url','<li style="list-style-image:url(https://example.invalid/PRIVATE_URL)">正文</li>']
   ]){
    document.getElementById('fixture')?.remove();
    const container=document.createElement('div');container.id='fixture';document.body.append(container);
    const root=document.createElement('div');root.className='markdown-preview-view';root.style.cssText='width:300px;height:600px;overflow:auto';container.append(root);
    const owner=document.createElement('div');owner.innerHTML='<ul>'+html+'</ul>';root.append(owner);
    const li=owner.querySelector('li'),source='- 合成源码',file={path:'fixture.md',stat:{mtime:1}},info={text:source,lineStart:0,lineEnd:0},contexts=new window.scanner.LayoutContexts();
    contexts.set(owner,{ctx:{sourcePath:file.path,getSectionInfo:()=>info},info});
    let writes=0;const plugin={contexts,cancelled:false,app:{vault:{read:async()=>source,modify:()=>{writes++;throw Error('write forbidden');}},metadataCache:{getFileCache:()=>({sections:[{type:'list',position:{start:{line:0},end:{line:0}}}]})}}};
    const view={containerEl:container,file,getMode:()=> 'preview',previewMode:{get:()=>source,getScroll:()=>root.scrollTop}};
    window.diagnosticsEnabled=false;const off=window.scanner.paragraphUnit(li);const reportOff=await window.targets.scanVisible(view,plugin,source,window.scanner);
    window.diagnosticsEnabled=true;const before=owner.innerHTML,on=window.scanner.paragraphUnit(li);const reportOn=await window.targets.scanVisible(view,plugin,source,window.scanner);
    rows.push({name,off,on,reportOff:JSON.parse(JSON.stringify(reportOff)),reportOn:JSON.parse(JSON.stringify(reportOn)),unchanged:before===owner.innerHTML,writes});
   }
   return rows;
  });
  const strip=value=>Array.isArray(value)?value.map(strip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!['diagnostics','capturedAt'].includes(k)).map(([k,v])=>[k,strip(v)])):value;
  for(const r of results){
   assert.deepEqual(strip(r.on),r.off,r.name+': unit decisions unchanged');
   assert.deepEqual(strip(r.reportOn),strip(r.reportOff),r.name+': complete report decisions unchanged');
   assert.ok(r.unchanged);assert.equal(r.writes,0);
   const d=r.on.diagnostics;assert.ok(d.entries.length<=24);assert.equal(d.limit,24);
   const serialized=JSON.stringify(d);assert.ok(!/PRIVATE_|<li|textContent|innerHTML/.test(serialized),r.name+': no content or URLs');
   for(const e of d.entries){assert.ok(e.domPath.length<=160&&e.className.length<=120&&e.rule.length<=64);assert.ok(Object.values(e.css).every(v=>v.length<=128));}
  }
  const d=results.find(r=>r.name==='styles').on.diagnostics.entries;
  assert.ok(d.some(e=>e.rule==='non-inline-layout'&&e.tagName==='SPAN'&&e.domPath==='0'&&e.css.display==='flex'));
  assert.ok(d.some(e=>e.rule==='position-transform'&&e.css.position==='relative'&&e.css.transform.startsWith('matrix')));
  assert.ok(d.some(e=>e.rule==='transparent-color'&&e.css.color==='rgba(0, 0, 0, 0)'));
  assert.ok(d.some(e=>e.rule==='list-marker'&&e.pseudo==='::marker'));
  assert.equal(results.find(r=>r.name==='bounded').on.diagnostics.truncated,true);
  assert.equal(results.find(r=>r.name==='plain').on.diagnostics.entries.length,0);
  console.log(JSON.stringify({passed:results.length,unitAndViewportDecisionsUnchanged:true,privacyAndLimitsVerified:true}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
