// Dependencies may be supplied by the host; no downloads or vault writes.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path=require('path');
const fs=require('fs');
(async()=>{
const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
const page=await browser.newPage();
await page.setContent('<style>p,li{font:16px sans-serif;width:120px;line-height:24px}pre{width:120px;padding:10px;white-space:pre-wrap;font:14px monospace}code{font:inherit}</style><p id="manual">第一行<br>结束</p><p id="auto">'+ ('测试'.repeat(7)+'测')+'</p><ul><li id="li">'+ ('测试'.repeat(7)+'测')+'<ul><li>子项</li></ul></li></ul><pre id="record"><code>ls\npwd\n结束\n</code></pre><pre id="wrapped"><code><span>测试</span>'+ '测试'.repeat(8)+'\nls\n</code></pre>');
let s=fs.readFileSync(process.argv[2] || path.join(__dirname,'..','main.js'),'utf8').split('class ResultModal')[0].split('\n').slice(1).join('\n');
await page.addScriptTag({content:s+'\nwindow.measurePrototype=measure;window.inspectPrototype=inspect;window.LayoutContextsPrototype=LayoutContexts;window.nearestHeadingPrototype=nearestHeading;'});
const result=await page.evaluate(()=>{
const m=window.measurePrototype;
return {manual:m(document.getElementById('manual')),auto:m(document.getElementById('auto')),li:m(document.getElementById('li'),{tightList:true}),record:m(document.querySelector('#record code'),{container:document.getElementById('record'),code:true}),wrapped:m(document.querySelector('#wrapped code'),{container:document.getElementById('wrapped'),code:true})};});
if(result.manual.suspected||result.manual.manualBreakCount!==1)throw Error('manual false positive');
if(result.auto.lineCount<2||!result.auto.suspected)throw Error('auto short tail missed');
if(result.li.text.includes('子项')||result.li.text!==result.auto.text||result.li.lineCount!==result.auto.lineCount)throw Error('tight list extraction failed');
if(result.record.lineCount!==3||result.record.suspected)throw Error('independent code lines false positive');
if(!result.wrapped.suspected||result.wrapped.tails[0].logicalLine!==1||result.wrapped.lastLine!=='ls')throw Error('earlier code line tail missed');
console.log(JSON.stringify({manualBreakProtected:true,autoTailDetected:true,tightListMeasured:true,nestedListNotDoubleCounted:true,independentCodeLinesProtected:true,earlierWrappedCodeLineDetected:true,logicalLines:result.wrapped.lines.map(x=>x.logicalLine)},null,2));
const scanChecks=await page.evaluate(async()=>{
  window.require=()=>({createHash:()=>({update(){return this},digest(){return 'fixture-hash'}})});
  if(window.nearestHeadingPrototype(['## 第六章','```bash','# 注释不是标题','```'],3,'')!=='第六章')throw Error('code comment treated as heading');
  document.body.innerHTML='<div id="container"><div class="markdown-preview-view" style="width:360px;height:150px;overflow:auto">'+Array.from({length:20},()=>'<div><p>重复样本用于验证源位置去重，不能因文字相同就合并不同段落</p></div>').join('')+'</div></div>';
  const root=document.querySelector('.markdown-preview-view'), file={path:'fixture.md',stat:{mtime:1}};
  const source=Array.from({length:20},()=> '重复样本').join('\n');
  const view={containerEl:document.getElementById('container'),file,getMode:()=> 'preview',previewMode:{get:()=>source,getScroll:()=>root.scrollTop,rerender:()=>{},applyScroll:n=>{root.scrollTop=n}}};
  const contexts=new window.LayoutContextsPrototype();
  root.querySelectorAll('p').forEach((p,i)=>contexts.set(p.parentElement,{ctx:{sourcePath:file.path,getSectionInfo:()=>({lineStart:i,lineEnd:i,text:source})},info:{lineStart:i,lineEnd:i,text:source}}));
  const plugin={contexts,cancelled:false,app:{vault:{read:async()=>source},metadataCache:{getFileCache:()=>({sections:Array.from({length:20},(_,i)=>({type:'paragraph',position:{start:{line:i},end:{line:i}}}))})}}};
  root.scrollTop=17;
  const first=await window.inspectPrototype(view,plugin,true);
  if(!first.scan.complete || first.blocks.length!==20 || root.scrollTop!==17)throw Error('full scan coverage, duplicates or restoration failed');
  const second=await window.inspectPrototype(view,plugin,true);
  if(second.blocks.length!==20)throw Error('repeated scan count changed');
  const firstOwner=root.querySelector('p').parentElement;const saved=contexts.get(firstOwner),staleInfo={...saved.info,text:'old version'};contexts.set(firstOwner,{ctx:{...saved.ctx,getSectionInfo:()=>staleInfo},info:staleInfo});
  const stale=await window.inspectPrototype(view,plugin,true);if(stale.scan.complete || !stale.scan.missingSourceLocations)throw Error('stale rendered version accepted');contexts.set(firstOwner,saved);
  view.previewMode.applyScroll=n=>{root.scrollTop=n;window.setTimeout(()=>{plugin.cancelled=true},70)};
  let cancelled=false;try{await window.inspectPrototype(view,plugin,true)}catch(e){cancelled=e.message.includes('取消')}
  if(!cancelled || root.scrollTop!==17)throw Error('cancel restoration failed');
  plugin.cancelled=false;
  view.previewMode.applyScroll=n=>{root.scrollTop=n};
  let measuredViewports=0,widthError=null;
  try{await window.inspectPrototype(view,plugin,true,(measuredRoot,result)=>{
    if(++measuredViewports!==1)return;
    // observe runs after collect, so the scan's width baseline already exists.
    if(measuredRoot!==root || root.clientWidth!==360 || !result.blocks.length)throw Error('width test requires a measured viewport at 360px');
    root.style.width='300px';
    if(root.clientWidth!==300)throw Error('width change injection failed');
  })}catch(e){widthError=e.message}
  if(measuredViewports!==1)throw Error('width test must stop after the first measured viewport');
  const widthGuard=!!widthError?.includes('阅读宽度发生变化');
  if(!widthGuard)throw Error('width guard failed: '+(widthError || 'scan unexpectedly succeeded'));
  if(root.scrollTop!==17)throw Error('width guard scroll restoration failed: '+root.scrollTop);
  return {fullCoverage:true,identicalParagraphsPreserved:20,repeatScanStable:true,scrollRestored:true,cancelGuard:true,widthGuard:true,codeHeadingGuard:true,staleRenderRejected:true};
});console.log(JSON.stringify(scanChecks,null,2));
await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
