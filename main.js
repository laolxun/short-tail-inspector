const {Plugin, MarkdownView, Modal, Notice} = require('obsidian');
const VERSION='0.2.1', THRESHOLD=0.25;
const round=n=>Math.round(n*10)/10;
const SELECTOR='h1,h2,h3,h4,h5,h6,p,pre,li';
class LayoutContexts {
  constructor(){this.nodes=new WeakMap();this.refs=new Set();}
  set(el,value){if(!this.nodes.has(el))this.refs.add(new WeakRef(el));this.nodes.set(el,value);}
  get(el){return this.nodes.get(el);}
  *[Symbol.iterator](){for(const ref of this.refs){const el=ref.deref();if(el)yield [el,this.nodes.get(el)];else this.refs.delete(ref);}}
  clear(){this.nodes=new WeakMap();this.refs.clear();}
}
function visible(el, viewport) {
  const r=el.getBoundingClientRect(), s=el.ownerDocument.defaultView.getComputedStyle(el);
  return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none' && r.bottom>viewport.top && r.top<viewport.bottom && r.right>viewport.left && r.left<viewport.right;
}
function measure(el, options={}) {
  const doc=el.ownerDocument, win=doc.defaultView;
  const container=options.container || el;
  const walker=doc.createTreeWalker(el,5), segments=new Intl.Segmenter('zh',{granularity:'grapheme'});
  const lines=[];
  let node, measured=0, segment=0, text='';
  const excluded=node=>{if(!options.tightList)return false;for(let p=node.parentElement;p && p!==el;p=p.parentElement)if(p.matches('p,pre,ul,ol,.callout'))return true;return false;};
  while ((node=walker.nextNode())) {
    if (node.nodeType===1) {if(node.tagName==='BR' && !excluded(node))segment++;continue;}
    if (excluded(node) || node.parentElement.closest('button,script,style,.copy-code-button,.sr-only'))continue;
    text+=node.nodeValue || '';
    for (const part of segments.segment(node.nodeValue || '')) {
      if (++measured>12000)throw new Error('文本过长，超过原型单块测量上限');
      if(options.code && part.segment==='\n') {segment++;continue;}
      if(options.code && part.segment==='\r')continue;
      const range=doc.createRange();range.setStart(node,part.index);range.setEnd(node,part.index+part.segment.length);
      const rects=Array.from(range.getClientRects()).filter(r=>r.width>0 && r.height>0);
      if(!rects.length)continue;
      const r=rects[0], center=(r.top+r.bottom)/2;
      let line=lines.find(l=>l.segment===segment && Math.abs(l.center-center)<Math.min(l.height,r.height)*0.55);
      if(!line) {line={center,height:r.height,left:Infinity,right:-Infinity,text:'',segment};lines.push(line);}
      line.text+=part.segment;
      if(part.segment.trim()) {line.left=Math.min(line.left,...rects.map(x=>x.left));line.right=Math.max(line.right,...rects.map(x=>x.right));}
    }
  }
  const style=win.getComputedStyle(container), box=container.getBoundingClientRect();
  const px=k=>parseFloat(style[k])||0;
  const width=box.width-px('paddingLeft')-px('paddingRight')-px('borderLeftWidth')-px('borderRightWidth');
  const rows=lines.sort((a,b)=>a.center-b.center).filter(l=>l.text.trim()).map(l=>({text:options.code?l.text.trimEnd():l.text.trim(),widthPx:round(Math.max(0,l.right-l.left)),segment:l.segment,logicalLine:l.segment+1}));
  const tails=[];
  for(const id of new Set(rows.map(r=>r.segment))) {
    const group=rows.filter(r=>r.segment===id), last=group[group.length-1];
    if(group.length>1 && width>0 && last.widthPx/width<THRESHOLD)tails.push({logicalLine:id+1,visualLineCount:group.length,text:last.text,widthPx:last.widthPx,ratioPercent:round(last.widthPx/width*100)});
  }
  const last=rows[rows.length-1], ratio=last && width>0?last.widthPx/width:null;
  return {text:text.trim(),lineCount:rows.length,availableWidthPx:round(width),lastLine:last?.text||'',lastLineWidthPx:last?.widthPx||0,lastLineRatio:ratio===null?null:round(ratio*100),manualBreakCount:segment,lastSegmentLineCount:last?rows.filter(r=>r.segment===last.segment).length:0,suspected:tails.length>0,tails,lines:rows};
}
function nearestHeading(source,start,fallback) {
  if(start===null)return fallback;
  let heading='',fence=null;
  for(let i=0;i<=start && i<source.length;i++) {
    const line=source[i], marker=line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/);
    if(marker){
      if(!fence)fence={char:marker[1][0],length:marker[1].length};
      else if(marker[1][0]===fence.char && marker[1].length>=fence.length && !marker[2].trim())fence=null;
      continue;
    }
    if(fence)continue;
    const m=line.match(/^#{1,6}\s+(.+)/);if(m)heading=m[1];
  }
  return heading || fallback;
}
function sectionFor(el, contexts, sourceText) {
  for(let p=el;p;p=p.parentElement) {
    const record=contexts.get(p); const ctx=record?.ctx;
    if(ctx) {if(typeof record.info?.text==='string' && record.info.text!==sourceText)return null;const info=ctx.getSectionInfo(el)||record.info;if(info)return {sourcePath:ctx.sourcePath,start:info.lineStart,end:info.lineEnd,owner:p};}
  }
  return null;
}
function elementPath(el,owner) {
  const path=[];
  while(el && el!==owner){path.push(Array.from(el.parentElement?.children||[]).indexOf(el));el=el.parentElement;}
  return path.reverse().join('.');
}
function collect(root,contexts,source,path) {
  const viewport=root.getBoundingClientRect(), blocks=[], skipped=[], ranges=[];
  let fallbackHeading=''; const sourceText=source.join('\n');
  for(const [owner,record] of contexts) {
    const ctx=record.ctx;
    if(!owner.isConnected)continue;
    if(!root.contains(owner) || !visible(owner,viewport) || ctx.sourcePath!==path)continue;
    if(typeof record.info?.text==='string' && record.info.text!==sourceText)continue;
    const info=ctx.getSectionInfo(owner)||record.info;if(info)ranges.push([info.lineStart,info.lineEnd]);
  }
  for(const el of root.querySelectorAll('table'))if(visible(el,viewport))skipped.push({key:'table:'+el.textContent,reason:'表格未支持逐单元格短尾检测'});
  for(const el of root.querySelectorAll(SELECTOR)) {
    if(/^H[1-6]$/.test(el.tagName))fallbackHeading=el.textContent.trim();
    if(!visible(el,viewport) || el.closest('table,.frontmatter,.metadata-container,.markdown-embed'))continue;
    const sec=sectionFor(el,contexts,sourceText);
    if(sec && sec.sourcePath!==path)continue;
    if(sec)ranges.push([sec.start,sec.end]);
    if(/^H[1-6]$/.test(el.tagName))continue;
    if(el.tagName==='P' && el.closest('pre'))continue;
    if(el.tagName==='LI' && el.querySelector(':scope > p'))continue;
    const heading=nearestHeading(source,sec?.start??null,fallbackHeading);
    const location=sec?{sourceStartLine:sec.start+1,sourceEndLine:sec.end+1,domPath:elementPath(el,sec.owner)}:{sourceStartLine:null,sourceEndLine:null,domPath:null};
    const key=sec?`${sec.start}:${sec.end}:${location.domPath}`:null;
    try {
      const code=el.tagName==='PRE';
      const target=code?(el.querySelector('code')||el):el;
      const result=measure(target,{container:el,code,tightList:el.tagName==='LI'});
      if(!result.text)continue;
      const kind=code?'代码块':el.closest('.callout[data-callout="k"]')?'K知识块':el.tagName==='LI'?'列表文本':'正文或引用';
      blocks.push({key,heading,kind,...location,protectedContent:code,characterDiagram:code && /[│├└┌┐┬┼─]/.test(result.text),...result});
    } catch(e) {skipped.push({key,heading,...location,reason:e.message});}
  }
  for(const el of root.querySelectorAll('.callout.is-collapsed'))if(visible(el,viewport))skipped.push({key:'collapsed:'+el.textContent,reason:'折叠知识块或 Callout 未展开，未检查内部内容'});
  return {blocks,skipped,ranges};
}
async function settle(root) {
  const win=root.ownerDocument.defaultView;
  await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));
  await new Promise(resolve=>win.setTimeout(resolve,50));
}
async function settleLayout(root) {
  let width=null,stable=0;
  for(let i=0;i<20;i++) {
    await settle(root);
    await new Promise(resolve=>root.ownerDocument.defaultView.setTimeout(resolve,60));
    const now=root.clientWidth;
    stable=now===width?stable+1:0;width=now;
    if(stable>=3)return;
  }
  throw new Error('布局仍在变化，请稍后重试');
}
async function refreshReading(view,plugin) {
  const file=view.file, source=await plugin.app.vault.read(file);
  if(view.getMode()!=='preview' || view.previewMode.get()!==source)throw new Error('阅读视图尚未同步最新文件，停止复检；请等待同步后重试');
  const scroll=view.previewMode.getScroll();
  view.previewMode.rerender(true);
  let root=view.containerEl.querySelector('.markdown-preview-view');
  await settleLayout(root);
  if(view.file!==file || view.getMode()!=='preview' || await plugin.app.vault.read(file)!==source || view.previewMode.get()!==source)throw new Error('刷新期间笔记版本或视图发生变化，停止复检');
  view.previewMode.applyScroll(scroll);
  await settle(root);
  return {method:'MarkdownPreviewView.rerender(true)',sourceVerified:true};
}
async function inspect(view,plugin,full=false) {
  if(view.getMode()!=='preview')throw new Error('请先将目标笔记切换到阅读视图');
  const root=view.containerEl.querySelector('.markdown-preview-view');
  if(!root)throw new Error('未找到阅读视图');
  const file=view.file;
  if(!file)throw new Error('没有目标文件');
  const refresh=full?await refreshReading(view,plugin):null;
  const sourceText=await plugin.app.vault.read(file), source=sourceText.split('\n');
  const sourceHash=require('crypto').createHash('sha256').update(sourceText).digest('hex');
  const expected=(plugin.app.metadataCache.getFileCache(file)?.sections||[]).filter(s=>s.type!=='yaml').map(s=>({type:s.type,start:s.position.start.line,end:s.position.end.line}));
  if(root.ownerDocument.fonts)await root.ownerDocument.fonts.ready;
  const originalScroll=root.scrollTop, originalWidth=root.clientWidth, mtime=file.stat.mtime;
  let blocks=new Map(),skipped=new Map(),ranges=[],steps=0,reachedEnd=false,missingLocations=false;
  const cancel=()=>{if(plugin.cancelled)throw new Error('已取消检测');if(view.file!==file || file.stat.mtime!==mtime || view.getMode()!=='preview')throw new Error('笔记或视图发生变化，检测已停止');if(root.clientWidth!==originalWidth)throw new Error('阅读宽度发生变化，检测已停止，请在固定布局下重试');};
  try {
    if(full)root.scrollTop=0;
    for(let i=0;i<(full?400:1);i++) {
      await settle(root);cancel();steps++;
      const result=collect(root,plugin.contexts,source,file.path);
      for(const b of result.blocks) {
        if(!b.key)missingLocations=true;
        const key=b.key || `${b.heading}|${b.kind}|${b.text}`;
        blocks.set(key,b);
      }
      for(const b of result.skipped)skipped.set(b.key || `${b.heading}|${b.reason}`,b);
      ranges.push(...result.ranges);
      if(!full)break;
      const max=Math.max(0,root.scrollHeight-root.clientHeight);
      if(root.scrollTop>=max-2) {await settle(root);if(root.scrollTop>=root.scrollHeight-root.clientHeight-2){reachedEnd=true;break;}}
      root.scrollTop=Math.min(max,root.scrollTop+Math.max(100,root.clientHeight*0.55));
    }
    cancel();
    if(await plugin.app.vault.read(file)!==sourceText)throw new Error('源文件内容发生变化，结果未导出');
  } finally {if(full && view.file===file && view.getMode()==='preview'){root.scrollTop=originalScroll;await settle(root);}}
  const uncovered=expected.filter(s=>!ranges.some(([a,b])=>a<=s.start && b>=s.end));

  const complete=full && reachedEnd && !missingLocations && expected.length>0 && uncovered.length===0;
  return {schemaVersion:2,pluginVersion:VERSION,capturedAt:new Date().toISOString(),file:file.path,fileMtime:mtime,sourceSha256:sourceHash,mode:'reading',scope:full?'全文逐屏扫描；折叠、嵌入、表格等未覆盖内容须另查':'当前可见文本；不是全文验收',scan:{refresh,full,reachedEnd,steps,complete,missingSourceLocations:missingLocations,expectedSectionCount:expected.length,uncoveredSections:uncovered},thresholdPercent:THRESHOLD*100,viewportWidthPx:originalWidth,blocks:Array.from(blocks.values()).sort((a,b)=>(a.sourceStartLine??Infinity)-(b.sourceStartLine??Infinity)||String(a.domPath).localeCompare(String(b.domPath),undefined,{numeric:true})),skipped:Array.from(skipped.values()),limitations:['表格、嵌入文档和图形不纳入测量','代码内容受保护，疑似问题不代表应改写命令或字符图','疑似阈值仅用于筛查，不代替语义判断']};
}
class ResultModal extends Modal {
  constructor(app,report,save){super(app);this.report=report;this.save=save;}
  onOpen() {
    const {contentEl}=this,r=this.report;
    contentEl.createEl('h2',{text:'短尾行检测原型 '+VERSION});
    contentEl.createEl('p',{text:r.file});
    contentEl.createEl('p',{text:r.scope});
    if(r.scan.full)contentEl.createEl('p',{text:r.scan.complete?'全文遍历与源区块覆盖核对完成（仍须查看未支持范围）':`覆盖未确认：到达末尾 ${r.scan.reachedEnd}；缺少位置 ${r.scan.missingSourceLocations}；未覆盖源区块 ${r.scan.uncoveredSections.length}`});
    contentEl.createEl('p',{text:`已测 ${r.blocks.length} 个文本块；疑似 ${r.blocks.filter(b=>b.suspected).length} 个；跳过 ${r.skipped.length} 个。结果为当前布局快照。`});
    const button=contentEl.createEl('button',{text:'导出检测结果 JSON'});
    button.addEventListener('click',async()=>{try{await this.save(r);new Notice('检测报告已导出');}catch(e){new Notice(e.message);}});
    for(const b of r.blocks) {
      const item=contentEl.createEl('details');item.open=b.suspected;
      item.createEl('summary',{text:`${b.suspected?'疑似短尾':'已测量'} · ${b.kind} · ${b.heading||'无章节'} · ${b.lineCount} 行 · 末行 ${b.lastLineRatio}%`});
      item.createEl('p',{text:b.text});
      item.createEl('p',{text:`源区块 ${b.sourceStartLine??'?'}～${b.sourceEndLine??'?'} 行；可用宽 ${b.availableWidthPx}px`});
      if(b.protectedContent)item.createEl('p',{text:'代码原内容受保护；源码换行独立判断，只标记同一源码行发生自动换行后的短尾'});
      if(b.manualBreakCount)item.createEl('p',{text:`主动断行 ${b.manualBreakCount} 处；各片段分别判断自动换行`});
      for(const t of b.tails)item.createEl('p',{text:`片段 ${t.logicalLine} 的短尾「${t.text}」：${t.ratioPercent}%`});
      const list=item.createEl('ol');for(const l of b.lines)list.createEl('li',{text:`${l.text}（${l.widthPx}px；片段 ${l.logicalLine}）`});
    }
    for(const s of r.skipped)contentEl.createEl('p',{text:`跳过：${s.heading||''} ${s.reason}`});
    for(const s of r.limitations)contentEl.createEl('p',{text:s});
  }
  onClose(){this.contentEl.empty();}
}
module.exports=class ShortTailInspector extends Plugin {
  async onload() {
    this.contexts=new LayoutContexts();this.busy=false;this.cancelled=false;this.lastRequestId=null;this.polling=false;
    this.registerInterval(window.setInterval(()=>{this.pollRequest().catch(()=>{});},500));
    this.registerMarkdownPostProcessor((el,ctx)=>{this.contexts.set(el,{ctx,info:ctx.getSectionInfo(el)});});
    this.addCommand({id:'inspect-visible-reading',name:'检测当前阅读视图短尾行',callback:()=>this.run(false,false)});
    this.addCommand({id:'export-visible-reading',name:'检测并导出当前阅读视图报告',callback:()=>this.run(true,false)});
    this.addCommand({id:'scan-entire-reading',name:'扫描整篇阅读视图并导出报告',callback:()=>this.run(true,true)});
    this.addCommand({id:'cancel-scan',name:'取消正在进行的检测',callback:()=>{this.cancelled=true;}});
  }
  onunload(){this.cancelled=true;this.contexts.clear();}
  async pollRequest() {
    if(this.polling)return;
    this.polling=true;
    const adapter=this.app.vault.adapter,dir=this.manifest.dir;
    let request=null,response=null,ownsBusy=false,leaf=null,originalState=null,originalEphemeral=null,changedMode=false,docks=[];
    try {
      if(!await adapter.exists(`${dir}/request.json`))return;
      try{request=JSON.parse(await adapter.read(`${dir}/request.json`));}catch{return;}
      if(typeof request.id!=='string'||! /^[A-Za-z0-9_-]{1,80}$/.test(request.id))return;
      if(request.id===this.lastRequestId)return;
      this.lastRequestId=request.id;
      if(await adapter.exists(`${dir}/response.json`)) {
        try{if(JSON.parse(await adapter.read(`${dir}/response.json`)).id===request.id)return;}catch{}
      }
      if(request.schemaVersion!==1 || request.action!=='scan')throw new Error('仅支持 schemaVersion 1 的 scan 请求');
      if(!Number.isFinite(request.expiresAt) || request.expiresAt<Date.now())throw new Error('请求已过期，请重新发起');
      if(this.busy)throw new Error('已有检测正在进行，请稍后重试');
      if(typeof request.file!=='string'||request.file.startsWith('/')||request.file.split('/').includes('..'))throw new Error('目标必须是库内笔记相对路径');
      if(typeof request.expectedSourceSha256!=='string'||! /^[a-f0-9]{64}$/.test(request.expectedSourceSha256))throw new Error('缺少源文件 SHA-256 校验值');
      const layout=request.expectedLayout;
      if(!layout || !Number.isFinite(layout.contentWidthPx)||!Number.isFinite(layout.fontSizePx))throw new Error('缺少约定的阅读宽度和字号');
      const matches=this.app.workspace.getLeavesOfType('markdown').filter(l=>l.view instanceof MarkdownView && l.view.file?.path===request.file && l.view.containerEl.getBoundingClientRect().width>0);
      if(matches.length!==1)throw new Error('请在主区域打开唯一的目标笔记，再发起检测');
      leaf=matches[0];const view=leaf.view;
      const source=await this.app.vault.read(view.file);
      const hash=require('crypto').createHash('sha256').update(source).digest('hex');
      if(hash!==request.expectedSourceSha256)throw new Error('笔记与请求版本不一致，请读取最新内容后重试');
      this.busy=true;ownsBusy=true;this.cancelled=false;
      originalState=leaf.getViewState();originalEphemeral=leaf.getEphemeralState();
      if(request.temporaryReadingLayout!==true)throw new Error('请求需明确允许临时阅读布局，并在完成后恢复');
      for(const dock of [this.app.workspace.leftSplit,this.app.workspace.rightSplit])if(dock && !dock.collapsed){docks.push(dock);dock.collapse();}
      if(view.getMode()!=='preview'){changedMode=true;await leaf.setViewState({...originalState,state:{...originalState.state,mode:'preview'}});}
      const target=leaf.view,root=target.containerEl.querySelector('.markdown-preview-view');
      if(!root)throw new Error('阅读视图尚未就绪');
      await settleLayout(root);
      const sizer=root.querySelector('.markdown-preview-sizer');
      const actualWidth=sizer?.getBoundingClientRect().width;
      const actualFont=parseFloat(root.ownerDocument.defaultView.getComputedStyle(root).fontSize);
      if(!Number.isFinite(actualWidth)||Math.abs(actualWidth-layout.contentWidthPx)>0.5||Math.abs(actualFont-layout.fontSizePx)>0.1)throw new Error(`布局不符合约定：内容区 ${round(actualWidth||0)}px，字号 ${round(actualFont)}px`);
      const report=await inspect(target,this,true);
      if(report.sourceSha256!==request.expectedSourceSha256)throw new Error('检测期间源文件版本变化');
      report.requestId=request.id;report.layout={contentWidthPx:round(actualWidth),fontSizePx:round(actualFont),sidebarsClosed:true};
      await this.save(report);
      response={id:request.id,status:report.scan.complete?'complete':'incomplete',reportPath:`${dir}/report.json`,archivePath:report.archivePath,sourceSha256:report.sourceSha256,blocks:report.blocks.length,suspected:report.blocks.filter(b=>b.suspected).length,skipped:report.skipped.length};
    } catch(error) {if(request?.id)response={id:request.id,status:'error',error:error.message};}
    finally {
      try{
        if(changedMode && leaf?.view.file?.path===request?.file){await leaf.setViewState(originalState);leaf.setEphemeralState(originalEphemeral);}
        for(const dock of docks)dock.expand();
        if(response)await adapter.write(`${dir}/response.json`,JSON.stringify({...response,completedAt:new Date().toISOString()},null,2));
      }finally{if(ownsBusy)this.busy=false;this.polling=false;}
    }
  }
  async save(report){
    const adapter=this.app.vault.adapter,dir=this.manifest.dir,history=`${dir}/reports`;
    if(!await adapter.exists(history))await adapter.mkdir(history);
    const id=report.requestId || require('crypto').randomUUID();
    const name=`${report.capturedAt.replace(/[:.]/g,'-')}-${id}.json`;
    const data=JSON.stringify(report,null,2);
    await adapter.write(`${history}/${name}`,data);
    report.archivePath=`${history}/${name}`;
    await adapter.write(`${dir}/report.json`,JSON.stringify(report,null,2));
  }
  async run(exportReport,full) {
    if(this.busy){new Notice('已有检测正在进行');return;}
    const view=this.app.workspace.getActiveViewOfType(MarkdownView);
    if(!view){new Notice('请先激活目标笔记的阅读视图');return;}
    this.busy=true;this.cancelled=false;
    if(full)new Notice('正在逐屏扫描，请保持笔记与阅读宽度不变；完成后恢复原位置');
    try{const report=await inspect(view,this,full);if(exportReport)await this.save(report);new ResultModal(this.app,report,r=>this.save(r)).open();}
    catch(error){new Notice(`检测未完成：${error.message}`);}
    finally{this.busy=false;}
  }
};
