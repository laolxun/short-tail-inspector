const {Plugin, MarkdownView, Modal, Notice} = require('obsidian');
const VERSION='0.2.4', THRESHOLD=0.25;
const round=n=>Math.round(n*10)/10;
const SELECTOR='h1,h2,h3,h4,h5,h6,p,pre,li';
class LayoutContexts {
  constructor(){this.nodes=new WeakMap();this.refs=new Set();this.snapshots=new WeakMap();}
  set(el,value){
    if(!this.nodes.has(el))this.refs.add(new WeakRef(el));this.nodes.set(el,value);
    this.snapshots.set(el,{record:value,ctx:value.ctx,sourcePath:value.ctx?.sourcePath,
      info:value.info?{text:value.info.text,lineStart:value.info.lineStart,lineEnd:value.info.lineEnd}:null,
      root:el.closest('.markdown-preview-view'),parent:el.parentElement,before:el.previousSibling,after:el.nextSibling,text:el.textContent});
  }
  get(el){return this.nodes.get(el);}
  snapshotFor(el){return this.snapshots.get(el);}
  *[Symbol.iterator](){for(const ref of this.refs){const el=ref.deref();if(el)yield [el,this.nodes.get(el)];else this.refs.delete(ref);}}
  clear(){this.nodes=new WeakMap();this.snapshots=new WeakMap();this.refs.clear();}
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
function sourceMappingFor(el, contexts, sourceText, options={}) {
  const root=options.root||el.closest('.markdown-preview-view'), failures=[];
  const lineCount=options.lineCount??sourceText.split('\n').length;
  const reject=(owner,reason)=>failures.push({reason,ownerTag:owner.tagName,ownerDomPath:root&&root.contains(owner)?elementPath(owner,root):null});
  const validate=info=>!info?'section-info-missing':info.text!==sourceText?'source-version-mismatch':
    !Number.isInteger(info.lineStart)||!Number.isInteger(info.lineEnd)||info.lineStart<0||info.lineEnd<info.lineStart||info.lineEnd>=lineCount?'invalid-source-range':null;
  if(!el.isConnected||root&&!root.contains(el))return {section:null,status:'unmapped',reason:'detached-node',failures};
  for(let p=el;p;p=p.parentElement) {
    const record=contexts.get(p); const ctx=record?.ctx;
    if(ctx) {
      if(root&&(p===root||!root.contains(p))){reject(p,'owner-outside-reading-content');break;}
      if(typeof ctx.sourcePath!=='string'||!ctx.sourcePath||options.filePath&&ctx.sourcePath!==options.filePath){reject(p,'source-path-mismatch');continue;}
      let info;
      try{info=ctx.getSectionInfo(el);}catch{reject(p,'section-api-error');continue;}
      let basis='live';
      if(!info) {
        const snapshot=contexts.snapshotFor?.(p);
        const stable=snapshot&&snapshot.record===record&&snapshot.ctx===ctx&&snapshot.sourcePath===ctx.sourcePath&&
          snapshot.root===root&&snapshot.parent===p.parentElement&&snapshot.before===p.previousSibling&&
          snapshot.after===p.nextSibling&&snapshot.text===p.textContent;
        if(!stable){reject(p,'cached-owner-unverified');continue;}
        if(validate(record.info)||validate(snapshot.info)||record.info.lineStart!==snapshot.info.lineStart||record.info.lineEnd!==snapshot.info.lineEnd){reject(p,'cached-section-invalid');continue;}
        info=snapshot.info;basis='registered-snapshot';
      }
      const reason=validate(info);
      if(reason){reject(p,reason);continue;}
      if(basis==='live'&&p!==el) {
        let ownerInfo;
        try{ownerInfo=ctx.getSectionInfo(p);}catch{reject(p,'owner-api-error');continue;}
        if(validate(ownerInfo)||ownerInfo.lineStart!==info.lineStart||ownerInfo.lineEnd!==info.lineEnd){reject(p,'owner-range-mismatch');continue;}
      }
      return {section:{sourcePath:ctx.sourcePath,start:info.lineStart,end:info.lineEnd,owner:p},status:'mapped',basis,failures};
    }
    if(p===root)break;
  }
  return {section:null,status:'unmapped',reason:failures.length?'no-trusted-candidate':'context-missing',failures};
}
function sectionFor(el, contexts, sourceText, options={}) {
  return sourceMappingFor(el,contexts,sourceText,options).section;
}
function elementPath(el,owner) {
  const path=[];
  while(el && el!==owner){path.push(Array.from(el.parentElement?.children||[]).indexOf(el));el=el.parentElement;}
  return path.reverse().join('.');
}
// A source container may own several paragraphs. This evidence describes only
// one complete P node; source identity/coverage remain the target scanner's job.
function paragraphUnit(el, measuredText) {
  const doc=el.ownerDocument, win=doc.defaultView, reasons=[];
  const styles=new Map(), boxes=new Map();
  const styleFor=node=>{if(!styles.has(node))styles.set(node,win.getComputedStyle(node));return styles.get(node);};
  const boxFor=node=>{if(!boxes.has(node))boxes.set(node,node.getBoundingClientRect());return boxes.get(node);};
  if(el.tagName!=='P')return {type:el.tagName==='LI'?'list-item-text':'code-block'};
  if(el.querySelector('p,pre,li,ul,ol,blockquote,.callout,table,img,svg,canvas,iframe,.markdown-embed,h1,h2,h3,h4,h5,h6'))reasons.push('段落包含其他独立块或嵌入');
  let text='', rawText='', count=0;const walker=doc.createTreeWalker(el,5);
  const nodes=[el,...el.querySelectorAll('*')];
  for(const node of nodes){
    const style=styleFor(node);
    if(node!==el && node.tagName!=='BR' && !['inline','inline-block','contents','none'].includes(style.display))reasons.push('段落内存在无法确认连续性的布局块');
    let hidden=false;
    for(let p=node;p;p=p.parentElement)if(styleFor(p).display==='none'){hidden=true;break;}
    if(hidden)continue;
    for(const pseudo of ['::before','::after']){
      const s=win.getComputedStyle(node,pseudo);
      // Only demonstrably absent content or literal whitespace/U+200B. Unknown
      // serialization is conservative, not a claim that content is visible.
      if(s.display==='none' || ['hidden','collapse'].includes(s.visibility) || ['none','normal'].includes(s.content) || /^(?:"[\t\n\r\f \u200B]*"|'[\t\n\r\f \u200B]*')$/.test(s.content))continue;
      reasons.push(`段落含未测或未知生成内容：${elementPath(node,el)}${pseudo}`);
    }
  }
  let node;
  while((node=walker.nextNode())){
    if(node.nodeType===1){if(node.tagName==='BR')text+='\n';continue;}
    text+=node.nodeValue||'';
    rawText+=node.nodeValue||'';
    for(const part of new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(node.nodeValue||'')){
      if(++count>12000){reasons.push('段落超过完整性核验上限');break;}
      if(!part.segment.trim())continue;
      const range=doc.createRange();range.setStart(node,part.index);range.setEnd(node,part.index+part.segment.length);
      const rects=Array.from(range.getClientRects()).filter(r=>r.width>0 && r.height>0);
      if(!rects.length || styleFor(node.parentElement).visibility!=='visible' || node.parentElement.closest('button,script,style,.copy-code-button,.sr-only'))reasons.push('段落有隐藏或未测字符');
      for(let p=node.parentElement;p;p=p.parentElement){
        const style=styleFor(p);
        if(style.display==='none' || style.opacity==='0')reasons.push('段落有隐藏字符');
        // Ancestor container clipping is checked by renderGroups. Here also
        // reject clipping inside P, which cannot be fixed by scrolling the note.
        if(el.contains(p)){
          const box=boxFor(p);
          if((/(hidden|clip|auto|scroll)/.test(style.overflowX) && rects.some(r=>r.left<box.left || r.right>box.right)) ||
             (/(hidden|clip|auto|scroll)/.test(style.overflowY) && rects.some(r=>r.top<box.top || r.bottom>box.bottom)))reasons.push('段落字符被内部容器裁切');
        }
      }
    }
    if(count>12000)break;
  }
  if(measuredText!==undefined && rawText.trim()!==measuredText)reasons.push('段落文本与测量结果不一致');
  return {type:'paragraph',text:text.trim(),complete:reasons.length===0,reasons:[...new Set(reasons)]};
}
function collect(root,contexts,source,path) {
  const viewport=root.getBoundingClientRect(), blocks=[], skipped=[], ranges=[];
  let fallbackHeading=''; const sourceText=source.join('\n');
  for(const [owner,record] of contexts) {
    const ctx=record.ctx;
    if(!owner.isConnected)continue;
    if(!root.contains(owner) || !visible(owner,viewport) || ctx.sourcePath!==path)continue;
    const sec=sectionFor(owner,contexts,sourceText,{root,filePath:path,lineCount:source.length});
    if(sec)ranges.push([sec.start,sec.end]);
  }
  const locate=el=>{
    const mapping=sourceMappingFor(el,contexts,sourceText,{root,filePath:path,lineCount:source.length}),sec=mapping.section;
    const domPath=sec?elementPath(el,sec.owner):null;
    const {section,...sourceMapping}=mapping;
    return {sec,key:sec?`${sec.start}:${sec.end}:${domPath}`:null,
      location:{sourceStartLine:sec?sec.start+1:null,sourceEndLine:sec?sec.end+1:null,domPath,
        renderDomPath:elementPath(el,root),sourceMapping}};
  };
  for(const el of root.querySelectorAll('table'))if(visible(el,viewport)) {
    const {sec,key,location}=locate(el);if(sec)ranges.push([sec.start,sec.end]);
    skipped.push({key:key||'table:'+el.textContent,kind:'表格',...location,reason:'表格未支持逐单元格短尾检测'});
  }
  for(const el of root.querySelectorAll(SELECTOR)) {
    if(/^H[1-6]$/.test(el.tagName))fallbackHeading=el.textContent.trim();
    if(!visible(el,viewport) || el.closest('table,.frontmatter,.metadata-container,.markdown-embed'))continue;
    const {sec,key,location}=locate(el);
    if(sec)ranges.push([sec.start,sec.end]);
    if(/^H[1-6]$/.test(el.tagName))continue;
    if(el.tagName!=='PRE' && el.closest('pre'))continue;
    if(el.tagName==='LI' && el.querySelector(':scope > p'))continue;
    const heading=nearestHeading(source,sec?.start??null,fallbackHeading);
    if(el.tagName==='PRE') {
      skipped.push({key:key||`code:${elementPath(el,root)}`,heading,kind:'代码块',...location,reason:'代码块内容受保护，跳过短尾检测'});
      continue;
    }
    try {
      const code=el.tagName==='PRE';
      const target=code?(el.querySelector('code')||el):el;
      const result=measure(target,{container:el,code,tightList:el.tagName==='LI'});
      if(!result.text)continue;
      const kind=code?'代码块':el.closest('.callout[data-callout="k"]')?'K知识块':el.tagName==='LI'?'列表文本':'正文或引用';
      const block = {key,heading,kind,...location,measurementUnit:paragraphUnit(el,result.text),protectedContent:code,characterDiagram:code && /[│├└┌┐┬┼─]/.test(result.text),...result};
      Object.defineProperty(block, 'renderNode', {value: el});
      blocks.push(block);
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
function sidebarState(workspace) {
  return [workspace.leftSplit,workspace.rightSplit].filter(Boolean).map(dock=>({dock,collapsed:dock.collapsed}));
}
async function closeSidebars(states) {
  for(const {dock,collapsed} of states)if(!collapsed)await dock.collapse();
}
async function restoreSidebars(states) {
  const errors=[];
  for(const {dock,collapsed} of states){try{
    if(dock.collapsed!==collapsed)await (collapsed?dock.collapse():dock.expand());
  }catch(e){errors.push(e.message);}}
  return errors;
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
async function inspect(view,plugin,full=false,observe=null) {
  if(view.getMode()!=='preview')throw new Error('请先将目标笔记切换到阅读视图');
  let root=view.containerEl.querySelector('.markdown-preview-view');
  if(!root)throw new Error('未找到阅读视图');
  const file=view.file;
  if(!file)throw new Error('没有目标文件');
  const refresh=full?await refreshReading(view,plugin):null;
  root=view.containerEl.querySelector('.markdown-preview-view');
  if(!root)throw new Error('刷新后未找到阅读视图');
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
      if(observe)observe(root,result);
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
    contentEl.style.setProperty('user-select','text');
    contentEl.style.setProperty('-webkit-user-select','text');
    contentEl.createEl('h2',{text:'短尾行检测原型 '+VERSION});
    const suspectedBlocks=r.blocks.filter(b=>b.suspected), suspected=suspectedBlocks.flatMap(b=>(b.tails||[]).map(t=>({block:b,tail:t}))), normal=r.blocks.filter(b=>!b.suspected);
    contentEl.createEl('p',{text:`${r.file.split('/').pop()} · ${r.scan.full?'全文逐屏':'当前可视区域'} · 已测 ${r.blocks.length} · 疑似 ${suspectedBlocks.length} · 跳过 ${r.skipped.length}`});
    if(r.scan.full)contentEl.createEl('p',{text:r.scan.complete?'全文遍历与源区块覆盖核对完成；仍须查看未支持范围':`覆盖未确认：到达末尾 ${r.scan.reachedEnd}；缺少位置 ${r.scan.missingSourceLocations}；未覆盖源区块 ${r.scan.uncoveredSections.length}`});
    else contentEl.createEl('p',{text:'仅检查当前可视区域，不代表全文验收。'});
    contentEl.createEl('p',{text:'结果为当前布局快照；疑似项仅供筛查，代码和字符图内容受保护。'});
    const button=contentEl.createEl('button',{text:'导出检测结果 JSON'});
    button.addEventListener('click',async()=>{try{await this.save(r);new Notice('检测报告已导出');}catch(e){new Notice(e.message);}});
    const section=contentEl.createEl('section');section.createEl('h3',{text:`疑似短尾（${suspected.length} 处）`});
    if(!suspected.length)section.createEl('p',{text:'本次已测内容中没有发现疑似短尾。未检测或跳过的内容仍需另行检查。'});
    for(const {block:b,tail:t} of suspected) {
      const item=section.createEl('details');
      item.createEl('summary',{text:`${b.kind} · ${b.heading||'无章节'} · 疑似短尾「${t.text||'文本不可用'}」 · ${t.ratioPercent??'未知'}%`});
      item.createEl('p',{text:b.text});
      if(b.protectedContent)item.createEl('p',{text:'代码内容受保护；源码换行独立判断，只标记自动换行形成的短尾'});
      if(b.manualBreakCount)item.createEl('p',{text:`含主动断行 ${b.manualBreakCount} 处；各段分别判断`});
    }
    const skipped=contentEl.createEl('details');skipped.createEl('summary',{text:`未检测/跳过（${r.skipped.length}）`});
    if(r.skipped.length) {const list=skipped.createEl('ul');for(const s of r.skipped)list.createEl('li',{text:`${s.heading?`${s.heading} · `:''}${s.reason||'未提供原因'}`});}
    else skipped.createEl('p',{text:'没有记录到跳过项。'});
    const measured=contentEl.createEl('details');measured.createEl('summary',{text:`完整测量明细（${normal.length}）`});
    for(const b of normal) {
      const item=measured.createEl('details');
      item.createEl('summary',{text:`${b.kind} · ${b.heading||'无章节'} · ${b.lastLine||'末行文本不可用'}`});
      item.createEl('p',{text:b.text});
      const list=item.createEl('ul');for(const l of b.lines)list.createEl('li',{text:l.text});
    }
    const limits=contentEl.createEl('details');limits.createEl('summary',{text:'限制与检测范围'});
    for(const s of r.limitations)limits.createEl('p',{text:s});
    for(const control of contentEl.querySelectorAll('button,summary')) {
      control.style.setProperty('user-select','none');
      control.style.setProperty('-webkit-user-select','none');
    }
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
    this.addCommand({id:'inspect-entire-reading',name:'检测整篇阅读视图短尾行',callback:()=>this.run(false,true)});
    this.addCommand({id:'scan-entire-reading',name:'扫描整篇阅读视图并导出报告',callback:()=>this.run(true,true)});
  }
  onunload(){this.cancelled=true;this.contexts.clear();}
  runtimeModule(name){
    const adapter=this.app.vault.adapter;
    if(typeof adapter.getBasePath!=='function')throw new Error('本地扫描模块需要桌面文件系统适配器');
    return require(require('path').join(adapter.getBasePath(),this.manifest.dir,`${name}.js`));
  }
  async pollRequest() {
    if(this.polling)return;
    this.polling=true;
    const adapter=this.app.vault.adapter,dir=this.manifest.dir;
    let request=null,response=null,ownsBusy=false,leaf=null,originalState=null,originalEphemeral=null,originalReadingScroll=null,changedMode=false,docks=[],phase='request',completedReport=null;
    try {
      if(!await adapter.exists(`${dir}/request.json`))return;
      try{request=JSON.parse(await adapter.read(`${dir}/request.json`));}catch{return;}
      if(typeof request.id!=='string'||! /^[A-Za-z0-9_-]{1,80}$/.test(request.id))return;
      if(request.id===this.lastRequestId)return;
      this.lastRequestId=request.id;
      if(await adapter.exists(`${dir}/response.json`)) {
        try{if(JSON.parse(await adapter.read(`${dir}/response.json`)).id===request.id)return;}catch{}
      }
      if(![1,2,3].includes(request.schemaVersion) || request.action!=='scan')throw new Error('仅支持 schemaVersion 1/2/3 的 scan 请求');
      if(request.fileSelector!==undefined)throw new Error('不支持文件选择模式，请提供明确的库内笔记路径');
      const scanMode=request.schemaVersion===3?request.scanMode:(request.schemaVersion===2?'targets':'full');
      if(!['visible','full','targets'].includes(scanMode))throw new Error('无效 scanMode');
      if(request.schemaVersion===3 && (scanMode==='full' || (scanMode==='visible' && request.targets!==undefined) || (scanMode==='targets' && (request.localOnly!==true || !Array.isArray(request.targets)||!request.targets.length))))throw new Error('新协议仅支持 visible 或禁止全文回退的 targets');
      if(request.schemaVersion===1 && request.targets!==undefined)throw new Error('定位扫描需要 schemaVersion 2');
      if(request.schemaVersion===2 && (!Array.isArray(request.targets)||!request.targets.length))throw new Error('定位扫描需要非空 targets');
      if(!Number.isFinite(request.expiresAt) || request.expiresAt<Date.now())throw new Error('请求已过期，请重新发起');
      if(this.busy)throw new Error('已有检测正在进行，请稍后重试');
      if(typeof request.file!=='string'||request.file.startsWith('/')||request.file.split('/').includes('..'))throw new Error('目标必须是库内笔记相对路径');
      if(typeof request.expectedSourceSha256!=='string'||! /^[a-f0-9]{64}$/.test(request.expectedSourceSha256))throw new Error('缺少源文件 SHA-256 校验值');
      const layout=request.schemaVersion===3?null:request.expectedLayout;
      if(request.schemaVersion!==3 && (!layout || !Number.isFinite(layout.contentWidthPx)||!Number.isFinite(layout.fontSizePx)))throw new Error('缺少约定的阅读宽度和字号');
      const matches=this.app.workspace.getLeavesOfType('markdown').filter(l=>l.view instanceof MarkdownView && l.view.file?.path===request.file && l.view.containerEl.getBoundingClientRect().width>0);
      if(matches.length!==1)throw new Error('请在主区域打开唯一的目标笔记，再发起检测');
      leaf=matches[0];const view=leaf.view;
      const source=await this.app.vault.read(view.file);
      const hash=require('crypto').createHash('sha256').update(source).digest('hex');
      if(hash!==request.expectedSourceSha256)throw new Error('笔记与请求版本不一致，请读取最新内容后重试');
      if(scanMode==='targets')this.runtimeModule('target-scan').resolveTargets(request.targets,source,this.app.metadataCache.getFileCache(view.file)||{});
      phase='layout';
      this.busy=true;ownsBusy=true;this.cancelled=false;
      originalState=leaf.getViewState();originalEphemeral=leaf.getEphemeralState();
      if(view.getMode()==='preview')originalReadingScroll=view.previewMode.getScroll();
      if(request.temporaryReadingLayout!==true)throw new Error('请求需明确允许临时阅读布局，并在完成后恢复');
      docks=sidebarState(this.app.workspace);await closeSidebars(docks);
      if(view.getMode()!=='preview'){changedMode=true;await leaf.setViewState({...originalState,state:{...originalState.state,mode:'preview'}});}
      const target=leaf.view,root=target.containerEl.querySelector('.markdown-preview-view');
      if(!root)throw new Error('阅读视图尚未就绪');
      if(root.ownerDocument.fonts)await root.ownerDocument.fonts.ready;
      await settleLayout(root);
      const sizer=root.querySelector('.markdown-preview-sizer');
      const actualWidth=sizer?.getBoundingClientRect().width;
      const actualFont=parseFloat(root.ownerDocument.defaultView.getComputedStyle(root).fontSize);
      if(!Number.isFinite(actualWidth)||actualWidth<=0||!Number.isFinite(actualFont)||actualFont<=0 || (layout && (Math.abs(actualWidth-layout.contentWidthPx)>0.5||Math.abs(actualFont-layout.fontSizePx)>0.1)))throw new Error(`布局不符合约定：内容区 ${round(actualWidth||0)}px，字号 ${round(actualFont)}px`);
      phase='scan';
      const hooks={sectionFor,elementPath,SELECTOR,settleLayout,refreshReading,inspect};
      const report=scanMode==='visible'
        ?await this.runtimeModule('target-scan').scanVisible(target,this,source,hooks)
        :scanMode==='targets'
          ?await this.runtimeModule('target-scan').scanTargets(target,this,request.targets,source,hooks,{localOnly:request.localOnly===true})
          :await inspect(target,this,true);
      if(report.sourceSha256!==request.expectedSourceSha256 || await this.app.vault.read(target.file)!==source)throw new Error('检测期间源文件版本变化');
      const finalRoot=target.containerEl.querySelector('.markdown-preview-view');
      const finalWidth=finalRoot?.querySelector('.markdown-preview-sizer')?.getBoundingClientRect().width;
      const finalFont=finalRoot?parseFloat(finalRoot.ownerDocument.defaultView.getComputedStyle(finalRoot).fontSize):NaN;
      if(!Number.isFinite(finalWidth)||!Number.isFinite(finalFont)||Math.abs(finalWidth-actualWidth)>0.5||Math.abs(finalFont-actualFont)>0.1)throw new Error('检测期间正文宽度或字号发生变化，结果未导出');
      report.requestId=request.id;
      if(request.schemaVersion===3){report.schemaVersion=4;report.scanMode=scanMode;report.localOnly=request.localOnly===true;}
      report.layout={contentWidthPx:round(actualWidth),fontSizePx:round(actualFont),sidebarsClosed:true};
      completedReport=report;
      phase='save';
      const saved=await this.save(report);
      const complete=scanMode==='visible'?report.visibleCoverage==='complete':report.targeting?report.targeting.coverage==='complete':report.scan.complete;
      response={id:request.id,status:complete?'complete':'incomplete',reportPath:`${dir}/report.json`,archivePath:saved.report.archivePath,sourceSha256:report.sourceSha256,blocks:report.blocks.length,suspected:report.blocks.filter(b=>b.suspected && (scanMode!=='visible' || b.capture?.coverage==='complete')).length,skipped:report.skipped.length,cleanup:saved.cleanup};
      if(request.schemaVersion===3)Object.assign(response,{schemaVersion:3,file:request.file,scanMode,localOnly:request.localOnly===true,completionScope:scanMode==='visible'?'viewport':'targets',scanMethod:'visible',documentCoverage:'not-scanned',...(scanMode==='visible'?{visibleCoverage:report.visibleCoverage}:{})});
      if(report.targeting)Object.assign(response,{schemaVersion:request.schemaVersion,completionScope:'targets',scanMethod:report.targeting.scanMethod,documentCoverage:report.documentCoverage,targetCoverage:report.targeting.coverage,targetResult:report.targeting.result,targets:report.targeting.targets});
    } catch(error) {if(request?.id)response={id:request.id,status:'error',error:error.message,errorPhase:phase,scanSucceeded:!!completedReport,...((request.schemaVersion===2 || request.schemaVersion===3 && request.scanMode==='targets')?{schemaVersion:request.schemaVersion,targetResult:'failed',scanTargetResult:completedReport?.targeting?.result}:{})};}
    finally {
      try{
        const restorationErrors=[];
        if(changedMode && leaf?.view.file?.path===request?.file){try{await leaf.setViewState(originalState);}catch(e){restorationErrors.push(e.message);}}
        restorationErrors.push(...await restoreSidebars(docks));
        if(ownsBusy && leaf?.view.file?.path===request?.file){try{
          leaf.setEphemeralState(originalEphemeral);
          if(originalReadingScroll!==null && leaf.view.getMode()==='preview'){
            const root=leaf.view.containerEl.querySelector('.markdown-preview-view');
            await settleLayout(root);leaf.view.previewMode.applyScroll(originalReadingScroll);await settle(root);
          }
        }catch(e){restorationErrors.push(e.message);}}
        if(response && restorationErrors.length){response={...response,status:'error',errorPhase:response.errorPhase||'restore',error:response.error||'阅读布局恢复未完成',restorationErrors};if(request.schemaVersion===2 || request.schemaVersion===3 && request.scanMode==='targets'){response.scanTargetResult=completedReport?.targeting?.result??response.scanTargetResult;response.targetResult='failed';}}
        if(response && request.schemaVersion===3)Object.assign(response,{schemaVersion:3,file:request.file,sourceSha256:request.expectedSourceSha256,scanMode:request.scanMode,localOnly:request.localOnly===true});
        if(response)await adapter.write(`${dir}/response.json`,JSON.stringify({...response,completedAt:new Date().toISOString()},null,2));
      }finally{if(ownsBusy)this.busy=false;this.polling=false;}
    }
  }
  async save(report){
    const saved=await this.runtimeModule('report-store').saveReport(this.app.vault.adapter,this.manifest.dir,report);
    if(saved.cleanup.warnings.length)new Notice('报告已保存；'+saved.cleanup.warnings.join('；'));
    return saved;
  }
  async run(exportReport,full) {
    if(this.busy){new Notice('已有检测正在进行');return;}
    const view=this.app.workspace.getActiveViewOfType(MarkdownView);
    if(!view){new Notice('请先激活目标笔记的阅读视图');return;}
    if(view.getMode()!=='preview' || !view.file){new Notice('请先将目标笔记切换到阅读视图');return;}
    const file=view.file,leaf=view.leaf;
    const sameView=()=>view.file===file && view.getMode()==='preview' && (!leaf || leaf.view===view) && this.app.workspace.getActiveViewOfType(MarkdownView)===view;
    let scroll=null,docks=[],report=null,error=null,saved=false;
    const restorationErrors=[];
    this.busy=true;this.cancelled=false;
    try{
      scroll=view.previewMode.getScroll();docks=sidebarState(this.app.workspace);
      await closeSidebars(docks);
      const root=view.containerEl.querySelector('.markdown-preview-view');
      if(!root)throw new Error('未找到阅读视图');
      if(root.ownerDocument.fonts)await root.ownerDocument.fonts.ready;
      await settleLayout(root);
      if(!sameView())throw new Error('笔记或视图发生变化，检测已停止');
      if(this.cancelled)throw new Error('已取消检测');
      if(full)new Notice('正在逐屏扫描，请保持笔记与阅读宽度不变；完成后恢复原位置');
      report=await inspect(view,this,full);
      if(!sameView())throw new Error('笔记或视图发生变化，结果未导出');
      if(this.cancelled)throw new Error('已取消检测');
      if(exportReport){await this.save(report);saved=true;}
    }catch(e){error=e.message;}
    finally{
      try{
        restorationErrors.push(...await restoreSidebars(docks));
        if(scroll!==null && sameView()){
          const root=view.containerEl.querySelector('.markdown-preview-view');
          try{if(!root)throw new Error('恢复时未找到阅读视图');await settleLayout(root);}catch(e){restorationErrors.push(e.message);}
          // A note/view may change while waiting for sidebar animations.
          if(sameView()){
            try{view.previewMode.applyScroll(scroll);}catch(e){restorationErrors.push(e.message);}
            try{if(root)await settle(root);}catch(e){restorationErrors.push(e.message);}
          }
        }
      }finally{this.busy=false;}
    }
    if(error)new Notice(`检测未完成：${error}`);
    if(restorationErrors.length)new Notice(`${saved?'报告已保存；':''}阅读布局恢复未完成：${restorationErrors.join('；')}`);
    if(report && !error && !restorationErrors.length && sameView()){
      try{new ResultModal(this.app,report,r=>this.save(r)).open();}
      catch(e){new Notice(`${saved?'报告已保存；':''}结果窗口未打开：${e.message}`);}
    }
  }
};
