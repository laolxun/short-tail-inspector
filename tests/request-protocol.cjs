const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {resolveTargets} = require('../target-scan');

function fixture(options = {}) {
  const source = '合成段落', sha = crypto.createHash('sha256').update(source).digest('hex');
  const request = {schemaVersion: options.version || 1, action: 'scan', id: 'test-request', file: 'fixture.md',
    expiresAt: Date.now() + 30000, expectedSourceSha256: sha, expectedLayout: {contentWidthPx: 700, fontSizePx: 16}, temporaryReadingLayout: true};
  if (request.schemaVersion === 2) request.targets = [{kind: 'lines', startLine: 1, endLine: 1}];
  if (options.targets) request.targets = options.targets;
  const calls = {inspect: [], targeted: 0, saves: 0, modes: [], ephemeral: 0, expanded: []};
  const root = {scrollTop: 55, clientWidth: 720, querySelector: () => ({getBoundingClientRect: () => ({width: 700})}),
    fontSize: '16px', ownerDocument: {fonts: {ready: Promise.resolve()}, defaultView: {getComputedStyle: () => ({fontSize: root.fontSize})}}};
  class MarkdownView {
    constructor() {this.file = {path: 'fixture.md', stat: {mtime: 1}};this.mode = options.mode || 'preview';this.containerEl = {getBoundingClientRect: () => ({width: 720}), querySelector: () => root};
      this.previewMode = {getScroll: () => root.scrollTop, applyScroll: scroll => {root.scrollTop = scroll;}};}
    getMode() {return this.mode;}
  }
  const view = new MarkdownView(), leaf = {view, getViewState: () => ({state: {mode: view.mode}}), getEphemeralState: () => ({cursor: 3}),
    setViewState: async state => {calls.modes.push(state.state.mode);if (options.restoreFailure && state.state.mode === 'source') throw new Error('mode restore failed');view.mode = state.state.mode;},
    setEphemeralState: () => {calls.ephemeral++;}};
  const dock = name => ({collapsed: !!options.closed, collapse() {this.collapsed = true;if(options.closeFailure===name)throw new Error('dock close failed');}, expand() {calls.expanded.push(name);this.collapsed = false;if (options.dockFailure === name) throw new Error('dock restore failed');}});
  const leftSplit = dock('left'), rightSplit = dock('right');
  const files = new Map([['plugin/request.json', JSON.stringify(request)]]);
  const adapter = {getBasePath: () => '/synthetic-vault', exists: async name => files.has(name), read: async name => files.get(name), write: async (name, value) => {if (options.responseFailure) throw new Error('response denied');files.set(name, value);}};
  const baseReport = () => ({schemaVersion: 2, file: 'fixture.md', sourceSha256: sha, scan: {full: true, complete: options.incomplete !== true}, blocks: [], skipped: []});
  const targeted = async () => {calls.targeted++;root.scrollTop = 100;
    if (options.scanFailure) throw new Error('scan failed');
    return {...baseReport(), targeting: {scanMethod: 'visible', coverage: options.incomplete ? 'uncovered' : 'complete', result: options.incomplete ? 'uncovered' : 'clear', targets: []}};};
  const module = {exports: {}};
  const context = vm.createContext({module, require: name => {
    if (name === 'obsidian') return {Plugin: class {}, MarkdownView, Modal: class {}, Notice: class {}};
    if (name === 'crypto') return crypto;
    if (name === 'path') return require('node:path');
    if (name === '/synthetic-vault/plugin/target-scan.js') return {resolveTargets, scanTargets: targeted};
    throw new Error('Unexpected require: ' + name);
  }, fakeInspect: async (_view, _plugin, full) => {calls.inspect.push(full);root.scrollTop = 100;
    if (options.fontChanged) root.fontSize = '18px';
    if (options.switchNote) view.file = {path: 'other.md'};
    if (options.scanFailure) throw new Error('scan failed');return baseReport();}});
  vm.runInContext(fs.readFileSync(require.resolve('../main.js'), 'utf8') + '\ninspect=fakeInspect;settleLayout=async()=>{};settle=async()=>{};', context);
  const plugin = new module.exports();
  Object.assign(plugin, {manifest: {dir: 'plugin'}, busy: false, polling: false, app: {vault: {adapter, read: async () => source}, workspace: {getLeavesOfType: () => [leaf], leftSplit, rightSplit}, metadataCache: {getFileCache: () => ({sections: [{type: 'paragraph', position: {start: {line: 0}, end: {line: 0}}}]})}}});
  plugin.save = async report => {calls.saves++;if (options.saveFailure) throw new Error('save failed');return {report: {...report, archivePath: 'plugin/reports/test.json'}, cleanup: {warnings: []}};};
  return {plugin, request, view, root, calls, leftSplit, rightSplit, response: () => JSON.parse(files.get('plugin/response.json'))};
}

test('schema 1 remains full; preview scroll and sidebars restored', async () => {
  const f = fixture();await f.plugin.pollRequest();
  assert.deepEqual(f.calls.inspect, [true]);assert.equal(f.calls.targeted, 0);
  assert.equal(f.response().status, 'complete');assert.equal(f.response().schemaVersion, undefined);
  assert.equal(f.root.scrollTop, 55);assert.equal(f.leftSplit.collapsed, false);assert.equal(f.rightSplit.collapsed, false);
});
test('schema 2 reports target scope separately; original source mode restored', async () => {
  const f = fixture({version: 2, mode: 'source'});await f.plugin.pollRequest();
  assert.equal(f.calls.targeted, 1);assert.deepEqual(f.calls.inspect, []);
  assert.equal(f.response().targetResult, 'clear');assert.equal(f.response().completionScope, 'targets');
  assert.deepEqual(f.calls.modes, ['preview', 'source']);assert.equal(f.view.mode, 'source');
});
test('incomplete targets cannot return complete/clear', async () => {
  const f = fixture({version: 2, incomplete: true});await f.plugin.pollRequest();
  assert.equal(f.response().status, 'incomplete');assert.equal(f.response().targetResult, 'uncovered');assert.equal(f.calls.saves, 1);
});
test('complete target response retains incomplete document diagnostics', async () => {
  const f = fixture({version: 2});
  f.plugin.runtimeModule = () => ({resolveTargets, scanTargets: async () => ({
    schemaVersion: 3, file: f.request.file, sourceSha256: f.request.expectedSourceSha256,
    scan: {full: true, complete: false, missingSourceLocations: true}, documentCoverage: 'incomplete',
    blocks: [{suspected: true}], skipped: [],
    targeting: {scanMethod: 'full', coverage: 'complete', result: 'suspected', targets: []}
  })});
  let saved;
  const save = f.plugin.save;f.plugin.save = async report => {saved = report;return save(report);};
  await f.plugin.pollRequest();
  assert.equal(f.response().status, 'complete');assert.equal(f.response().targetCoverage, 'complete');
  assert.equal(f.response().targetResult, 'suspected');assert.equal(f.response().documentCoverage, 'incomplete');
  assert.equal(saved.scan.complete, false);assert.equal(saved.scan.missingSourceLocations, true);
});
test('schema 1 target extension rejected before changing layout', async () => {
  const f = fixture({targets: [{kind: 'lines', startLine: 1, endLine: 1}]});await f.plugin.pollRequest();
  assert.equal(f.response().status, 'error');assert.equal(f.calls.saves, 0);assert.deepEqual(f.calls.expanded, []);
});
test('invalid target range rejected before changing layout', async () => {
  const f = fixture({version: 2, targets: [{kind: 'lines', startLine: 0, endLine: 1}]});await f.plugin.pollRequest();
  assert.equal(f.response().errorPhase, 'request');assert.equal(f.calls.targeted, 0);assert.deepEqual(f.calls.expanded, []);
});
test('scan error distinguished from uncovered and save error; restoration still runs', async () => {
  const f = fixture({version: 2, scanFailure: true});await f.plugin.pollRequest();
  assert.equal(f.response().status, 'error');assert.equal(f.response().targetResult, 'failed');assert.equal(f.response().errorPhase, 'scan');
  assert.equal(f.response().scanSucceeded, false);assert.equal(f.calls.saves, 0);assert.equal(f.root.scrollTop, 55);
});
test('save error preserves scan success information and restores layout', async () => {
  const f = fixture({version: 2, saveFailure: true});await f.plugin.pollRequest();
  assert.equal(f.response().errorPhase, 'save');assert.equal(f.response().scanSucceeded, true);assert.equal(f.response().scanTargetResult, 'clear');
  assert.equal(f.root.scrollTop, 55);assert.equal(f.plugin.busy, false);assert.equal(f.plugin.polling, false);
});
test('mode restoration failure cannot skip dock restoration or error response', async () => {
  const f = fixture({version: 2, mode: 'source', restoreFailure: true});await f.plugin.pollRequest();
  assert.deepEqual(f.calls.expanded, ['left', 'right']);assert.equal(f.response().errorPhase, 'restore');assert.equal(f.response().status, 'error');assert.equal(f.response().targetResult, 'failed');
});
test('save and restore failures preserve the original completed scan result', async () => {
  for (const options of [{dockFailure: 'left'}, {mode: 'source', restoreFailure: true}]) {
    const f = fixture({version: 2, saveFailure: true, ...options});await f.plugin.pollRequest();
    const response = f.response();
    assert.equal(response.status, 'error');assert.equal(response.targetResult, 'failed');
    assert.equal(response.errorPhase, 'save');assert.equal(response.scanSucceeded, true);
    assert.equal(response.scanTargetResult, 'clear');assert.equal(response.restorationErrors.length, 1);
    assert.deepEqual(f.calls.expanded, ['left', 'right']);assert.equal(f.plugin.busy, false);assert.equal(f.plugin.polling, false);
  }
});
test('one dock restoration failure cannot skip other dock or scroll restoration', async () => {
  const f = fixture({dockFailure: 'left'});await f.plugin.pollRequest();
  assert.deepEqual(f.calls.expanded, ['left', 'right']);assert.equal(f.root.scrollTop, 55);assert.equal(f.response().status, 'error');
});
test('initially closed docks stay closed', async () => {
  const f = fixture({closed: true});await f.plugin.pollRequest();assert.deepEqual(f.calls.expanded, []);assert.equal(f.leftSplit.collapsed, true);
});
for(const closeFailure of ['left','right'])test(`request sidebar close failure (${closeFailure}) restores partial layout`,async()=>{
  const f=fixture({closeFailure});await f.plugin.pollRequest();
  assert.equal(f.response().errorPhase,'layout');assert.equal(f.response().status,'error');assert.equal(f.calls.saves,0);assert.deepEqual(f.calls.inspect,[]);
  assert.equal(f.leftSplit.collapsed,false);assert.equal(f.rightSplit.collapsed,false);assert.equal(f.root.scrollTop,55);assert.equal(f.plugin.busy,false);assert.equal(f.plugin.polling,false);
});
test('switching note does not force original view state onto the new note', async () => {
  const f = fixture({switchNote: true, scanFailure: true});await f.plugin.pollRequest();
  assert.equal(f.view.file.path, 'other.md');assert.equal(f.calls.ephemeral, 0);assert.deepEqual(f.calls.expanded, ['left', 'right']);
});
test('response write failure releases busy and polling', async () => {
  const f = fixture({responseFailure: true});await assert.rejects(f.plugin.pollRequest(), /response denied/);
  assert.equal(f.plugin.busy, false);assert.equal(f.plugin.polling, false);assert.equal(f.root.scrollTop, 55);
});
test('font change with stable root width is rejected before saving', async () => {
  const f = fixture({fontChanged: true});await f.plugin.pollRequest();
  assert.equal(f.response().status, 'error');assert.equal(f.response().errorPhase, 'scan');assert.equal(f.calls.saves, 0);assert.equal(f.root.scrollTop, 55);
});
