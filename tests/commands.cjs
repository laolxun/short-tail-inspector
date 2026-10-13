const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function fixture(options = {}) {
  if(typeof options==='boolean')options={scanFailure:options};
  const commands = new Map(), inspected = [], saved = [], modals = [], notices = [], events=[];
  let f,layoutCalls=0,saveCalls=0;
  function element() {
    return {children: [], listeners: {}, style:{setProperty(){}}, querySelectorAll(selector) {
      const tags=selector.split(',');return this.children.flatMap(child=>[...(tags.includes(child.tag)?[child]:[]),...child.querySelectorAll(selector)]);
    }, createEl(tag, options) {
      const child = {...element(), tag, options};this.children.push(child);return child;
    }, addEventListener(event, callback) {this.listeners[event] = callback;}};
  }
  class Plugin {
    addCommand(command) {assert(!commands.has(command.id));commands.set(command.id, command);}
    registerInterval() {}
    registerMarkdownPostProcessor() {}
  }
  class MarkdownView {}
  class Modal {
    constructor() {this.contentEl = element();}
    open() {events.push('modal');assert.equal(f.plugin.busy,false);assert.equal(root.scrollTop,55);modals.push(this);this.onOpen();}
  }
  const view = new MarkdownView(), module = {exports: {}};
  const root={scrollTop:55,ownerDocument:{fonts:{ready:Promise.resolve()}}};
  const dock=(name,closed)=>({collapsed:closed,
    async collapse(){events.push('close:'+name);if(options.closeFailure===name && options.failBeforeChange)throw Error('close failed: '+name);this.collapsed=true;root.scrollTop=88;if(options.closeFailure===name)throw Error('close failed: '+name);},
    async expand(){events.push('restore:'+name);this.collapsed=false;root.scrollTop=99;if(options.restoreFailure===name)throw Error('restore failed: '+name);}});
  const leftSplit=dock('left',!!options.leftClosed),rightSplit=dock('right',!!options.rightClosed);
  Object.defineProperty(root,'clientWidth',{get:()=>500+100*Number(leftSplit.collapsed)+100*Number(rightSplit.collapsed)});
  Object.assign(view,{file:{path:'synthetic.md'},mode:options.mode||'preview',getMode(){return this.mode;},containerEl:{querySelector:()=>root},
    previewMode:{getScroll:()=>{events.push('capture-scroll');return root.scrollTop;},applyScroll:scroll=>{events.push('scroll');if(options.scrollFailure)throw Error('scroll failed');root.scrollTop=scroll;}}});
  const leaf={view};view.leaf=leaf;
  const workspace={active:view,getActiveViewOfType(){return this.active;},leftSplit,rightSplit};
  const context = vm.createContext({module, window: {setInterval: () => 1}, require: name => {
    assert.equal(name, 'obsidian');return {Plugin, MarkdownView, Modal, Notice: class {constructor(text) {notices.push(text);}}};
  }, fakeInspect: async (actualView, plugin, full) => {
    assert.equal(actualView, view);assert.equal(leftSplit.collapsed,true);assert.equal(rightSplit.collapsed,true);
    assert(events.includes('layout:prepare'));assert.equal(root.clientWidth,700);events.push('scan');inspected.push(full);root.scrollTop=100;
    if(options.duringScan)await options.duringScan(f);
    if (options.scanFailure) throw new Error('synthetic scan failure');
    const report={file: 'folder/synthetic.md', scope: 'synthetic', scan: {full, complete: full, reachedEnd:full, missingSourceLocations:false, uncoveredSections:[]}, blocks: [
      {suspected:true,kind:'代码块',heading:'章节甲',lastLine:'Type',lastLineRatio:5.6,sourceStartLine:10,sourceEndLine:16,text:'长源码行在此视觉折行后结束为放6\n独立字符图末行 Type',lastLineWidthPx:20,availableWidthPx:360,lineCount:5,protectedContent:true,manualBreakCount:6,tails:[{logicalLine:2,text:'放6',ratioPercent:3.7,visualLineCount:2,widthPx:13.3},{logicalLine:4,text:'另一处短尾',ratioPercent:8.2,visualLineCount:2,widthPx:29.5}],lines:[{text:'长源码行前半',widthPx:350,logicalLine:2},{text:'放6',widthPx:13.3,logicalLine:2},{text:'字符图枝干',widthPx:180,logicalLine:4},{text:'另一处短尾',widthPx:29.5,logicalLine:4},{text:'Type',widthPx:20,logicalLine:7}]},
      {suspected:false,kind:'正文或引用',heading:'章节乙',lastLine:'normal',lastLineRatio:60,sourceStartLine:20,sourceEndLine:21,text:'normal full text',lastLineWidthPx:96,availableWidthPx:160,lineCount:1,lines:[{text:'normal',widthPx:96,logicalLine:1}]}
    ], skipped:[{heading:'章节丙',reason:'表格未支持逐单元格短尾检测'}], limitations:['表格、嵌入文档和图形不纳入测量']};
    if(options.zeroSuspicion)report.blocks=report.blocks.filter(b=>!b.suspected);
    return report;
  },fakeSettleLayout:async()=>{
    const phase=++layoutCalls===1?'prepare':'restore';events.push('layout:'+phase);
    if(options.duringLayout)await options.duringLayout(f,phase);
    if(options.layoutFailure===phase)throw Error('layout failed: '+phase);
  },fakeSettle:async()=>{events.push('settled');assert.equal(f.plugin.busy,true);
  }});
  vm.runInContext(fs.readFileSync(require.resolve('../main.js'), 'utf8') + '\ninspect=fakeInspect;settleLayout=fakeSettleLayout;settle=fakeSettle;', context);
  const plugin = new module.exports();
  plugin.app = {workspace};
  plugin.save = async report => {saveCalls++;events.push('save');if(options.saveFailure)throw Error('synthetic save failure');saved.push(report);};
  f={plugin,commands,inspected,saved,modals,notices,events,root,view,leaf,workspace,leftSplit,rightSplit,get saveCalls(){return saveCalls;}};
  await plugin.onload();
  return f;
}

test('only four scan commands remain with unchanged names and scan/export flags', async () => {
  const f = await fixture(), calls = [];
  f.plugin.run = (...args) => {calls.push(args);};
  const expected = [
    ['inspect-visible-reading', '检测当前阅读视图短尾行', false, false],
    ['export-visible-reading', '检测并导出当前阅读视图报告', true, false],
    ['inspect-entire-reading', '检测整篇阅读视图短尾行', false, true],
    ['scan-entire-reading', '扫描整篇阅读视图并导出报告', true, true],
  ];
  assert.equal(f.commands.size, 4);
  for (const [id, name, ...flags] of expected) {
    const command = f.commands.get(id);assert.equal(command.name, name);command.callback();
    assert.deepEqual(calls.at(-1), flags);
  }
  assert.equal(f.commands.has('cancel-scan'),false);
});

test('new entire-note command displays the full scan without saving; modal can export manually', async () => {
  const f = await fixture();await f.commands.get('inspect-entire-reading').callback();
  assert.deepEqual(f.inspected, [true]);assert.equal(f.saved.length, 0);assert.equal(f.modals.length, 1);
  const modal = f.modals[0];assert.equal(modal.report.scan.full, true);assert.equal(f.plugin.busy, false);
  const text=el=>el.options?.text||'';
  const all=el=>[el,...(el.children||[]).flatMap(all)];
  const nodes=all(modal.contentEl), details=nodes.filter(el=>el.tag==='details');
  assert(nodes.some(el=>text(el).includes('synthetic.md · 全文逐屏 · 已测 2 · 疑似 1 · 跳过 1')));
  assert(nodes.some(el=>text(el).includes('全文遍历与源区块覆盖核对完成')));
  const summaries=nodes.filter(el=>el.tag==='summary').map(text);
  assert(summaries.includes('代码块 · 章节甲 · 疑似短尾「放6」 · 3.7%'));
  assert(summaries.includes('代码块 · 章节甲 · 疑似短尾「另一处短尾」 · 8.2%'));
  assert(!summaries.some(t=>t.includes('Type')));
  assert(nodes.some(el=>text(el).includes('疑似短尾（2 处）')));
  assert(nodes.some(el=>text(el).includes('未检测/跳过（1）')));
  assert(nodes.some(el=>text(el).includes('表格未支持逐单元格短尾检测')));
  assert(nodes.some(el=>text(el).includes('完整测量明细（1）')));
  assert(details.every(el=>el.open!==true));
  assert(nodes.some(el=>text(el)==='长源码行在此视觉折行后结束为放6\n独立字符图末行 Type'));
  assert(nodes.some(el=>text(el).includes('代码内容受保护')));
  const resultRegions=modal.contentEl.children.filter(el=>el.tag==='section'||(el.tag==='details'&&el.children.some(child=>child.tag==='summary'&&text(child)==='完整测量明细（1）')));
  assert.equal(resultRegions.length,2);
  assert(!resultRegions.flatMap(all).some(el=>/源行|源区块|像素|可用宽|视觉行|片段\s*\d|\d+px/.test(text(el))));
  assert.equal(nodes.reduce((count,el)=>count+(text(el).match(/3\.7%/g)||[]).length,0),1);
  assert.equal(nodes.reduce((count,el)=>count+(text(el).match(/8\.2%/g)||[]).length,0),1);
  const button = modal.contentEl.children.find(child => child.tag === 'button');
  assert.equal(button.options.text, '导出检测结果 JSON');await button.listeners.click();
  assert.deepEqual(f.saved, [modal.report]);
  assert.equal(f.saved[0].blocks[0].sourceStartLine,10);
  assert.equal(f.saved[0].blocks[0].lastLine,'Type');
  assert.equal(f.saved[0].blocks[0].lastLineRatio,5.6);
  assert.equal(f.saved[0].blocks[0].lastLineWidthPx,20);
  assert.equal(f.saved[0].blocks[0].tails.length,2);
  assert.equal(f.saved[0].blocks[0].tails[0].text,'放6');
  assert.equal(f.saved[0].blocks[0].lines[1].logicalLine,2);
});

test('visible zero-suspicion modal states the inspected scope without claiming skipped content is clear', async()=>{
  const f=await fixture({zeroSuspicion:true});await f.commands.get('inspect-visible-reading').callback();
  const all=el=>[el,...(el.children||[]).flatMap(all)],nodes=all(f.modals[0].contentEl),texts=nodes.map(el=>el.options?.text||'');
  assert(texts.some(t=>t.includes('当前可视区域 · 已测 1 · 疑似 0 · 跳过 1')));
  assert(texts.some(t=>t.includes('本次已测内容中没有发现疑似短尾。未检测或跳过的内容仍需另行检查。')));
  assert(texts.includes('仅检查当前可视区域，不代表全文验收。'));
  assert(!nodes.some(el=>/源行|源区块|像素|可用宽|视觉行|片段\s*\d|\d+px/.test(el.options?.text||'')));
});

test('original visible and exporting commands keep their actual scan and save behavior', async () => {
  for (const [id, full, saves] of [['inspect-visible-reading', false, 0], ['export-visible-reading', false, 1], ['scan-entire-reading', true, 1]]) {
    const f = await fixture();await f.commands.get(id).callback();
    assert.deepEqual(f.inspected, [full]);assert.equal(f.saved.length, saves);assert.equal(f.modals.length, 1);
    if (saves) assert.equal(f.saved[0], f.modals[0].report);
  }
});

test('new entire-note command does not save or display a result after scan failure', async () => {
  const f = await fixture(true);await f.commands.get('inspect-entire-reading').callback();
  assert.deepEqual(f.inspected, [true]);assert.equal(f.saved.length, 0);assert.equal(f.modals.length, 0);
  assert.equal(f.plugin.busy, false);assert(f.notices.some(text => text.includes('synthetic scan failure')));
});

for(const [id,full,exports] of [['inspect-visible-reading',false,false],['export-visible-reading',false,true],['inspect-entire-reading',true,false],['scan-entire-reading',true,true]]){
  for(const leftClosed of [false,true])for(const rightClosed of [false,true]){
    test(`${id} restores original layout (${leftClosed}, ${rightClosed}) after stable scan`,async()=>{
      const f=await fixture({leftClosed,rightClosed});await f.commands.get(id).callback();
      assert.deepEqual(f.inspected,[full]);assert.equal(f.saved.length,Number(exports));assert.equal(f.modals.length,1);
      assert.equal(f.leftSplit.collapsed,leftClosed);assert.equal(f.rightSplit.collapsed,rightClosed);assert.equal(f.root.scrollTop,55);assert.equal(f.plugin.busy,false);
      assert.equal(f.events[0],'capture-scroll');assert(f.events.indexOf('layout:prepare')<f.events.indexOf('scan'));
      assert(f.events.indexOf('layout:restore')<f.events.indexOf('scroll'));assert(f.events.indexOf('settled')<f.events.indexOf('modal'));
      if(exports)assert(f.events.indexOf('save')<f.events.indexOf('layout:restore'));
    });
  }
}

for(const closeFailure of ['left','right'])for(const failBeforeChange of [false,true]){
  test(`partial sidebar close failure (${closeFailure}, ${failBeforeChange}) restores both original states`,async()=>{
    const f=await fixture({closeFailure,failBeforeChange});await f.plugin.run(false,true);
    assert.equal(f.inspected.length,0);assert.equal(f.saveCalls,0);assert.equal(f.modals.length,0);
    assert.equal(f.leftSplit.collapsed,false);assert.equal(f.rightSplit.collapsed,false);assert.equal(f.root.scrollTop,55);assert.equal(f.plugin.busy,false);
    assert(f.notices.some(n=>n.includes('close failed: '+closeFailure)));
  });
}

for(const options of [{layoutFailure:'prepare'},{scanFailure:true},{saveFailure:true},{restoreFailure:'left'},{layoutFailure:'restore'},{scrollFailure:true}]){
  test(`failure recovery remains independent: ${JSON.stringify(options)}`,async()=>{
    const f=await fixture(options);await f.plugin.run(true,true);
    assert.equal(f.leftSplit.collapsed,false);assert.equal(f.rightSplit.collapsed,false);assert.equal(f.plugin.busy,false);assert.equal(f.modals.length,0);
    if(!options.scrollFailure)assert.equal(f.root.scrollTop,55);
    if(options.layoutFailure==='prepare'||options.scanFailure)assert.equal(f.saveCalls,0);
    if(options.restoreFailure||options.layoutFailure==='restore'||options.scrollFailure){
      assert.equal(f.saved.length,1);assert(f.notices.some(n=>n.includes('报告已保存；阅读布局恢复未完成')));
      assert(!f.notices.some(n=>n.includes('检测未完成')));
    }
    if(options.restoreFailure)assert.deepEqual(f.events.filter(e=>e.startsWith('restore:')),['restore:left','restore:right']);
  });
}

test('primary save error and separate restoration error are both preserved',async()=>{
  const f=await fixture({saveFailure:true,restoreFailure:'left'});await f.plugin.run(true,true);
  assert(f.notices.some(n=>n.includes('检测未完成：synthetic save failure')));
  assert(f.notices.some(n=>n.includes('阅读布局恢复未完成：restore failed: left')));
  assert(!f.notices.some(n=>n.includes('报告已保存')));assert.equal(f.plugin.busy,false);assert.equal(f.root.scrollTop,55);
});

for(const name of ['leftSplit','rightSplit'])test(`originally closed ${name} is restored if opened during the scan`,async()=>{
  const f=await fixture({leftClosed:true,rightClosed:true,duringScan:f=>{f[name].collapsed=false;}});
  await f.plugin.run(false,false);
  assert.equal(f.leftSplit.collapsed,true);assert.equal(f.rightSplit.collapsed,true);assert.equal(f.root.scrollTop,55);assert.equal(f.plugin.busy,false);
});

for(const change of ['file','leaf','active','mode']){
  for(const phase of ['prepare','scan','restore'])test(`${change} change during ${phase} does not restore into the new view`,async()=>{
    const switchView=f=>{if(change==='file')f.view.file={path:'other.md'};else if(change==='leaf')f.leaf.view={};else if(change==='active')f.workspace.active={};else f.view.mode='source';f.root.scrollTop=444;};
    const options=phase==='scan'?{duringScan:switchView}:{duringLayout:(f,p)=>{if(p===phase)switchView(f);}};
    const f=await fixture(options);await f.plugin.run(false,true);
    assert(!f.events.includes('scroll'));assert.equal(f.modals.length,0);assert.equal(f.plugin.busy,false);
    assert.equal(f.leftSplit.collapsed,false);assert.equal(f.rightSplit.collapsed,false);
    if(phase==='prepare')assert.equal(f.inspected.length,0);
  });
}

test('internal unload cancellation still prevents save and restores layout',async()=>{
  const f=await fixture({duringScan:f=>f.plugin.onunload()});await f.plugin.run(true,true);
  assert.equal(f.plugin.cancelled,true);assert.equal(f.saveCalls,0);assert.equal(f.modals.length,0);assert.equal(f.plugin.busy,false);
  assert.equal(f.root.scrollTop,55);assert.equal(f.leftSplit.collapsed,false);assert.equal(f.rightSplit.collapsed,false);
  assert(f.notices.some(n=>n.includes('已取消检测')));
});

test('source mode is rejected without changing layout; busy request is also rejected',async()=>{
  const f=await fixture({mode:'source'});await f.plugin.run(false,false);assert.deepEqual(f.events,[]);assert.equal(f.plugin.busy,false);
  f.view.mode='preview';f.plugin.busy=true;await f.plugin.run(false,false);assert.deepEqual(f.events,[]);assert.equal(f.plugin.busy,true);
});
