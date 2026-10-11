const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {saveReport} = require('../report-store');

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sti-store-test-')));
  t.after(() => fs.rm(base, {recursive: true, force: true}));
  await fs.mkdir(path.join(base, 'plugin'));
  return {base, dir: 'plugin', adapter: {getBasePath: () => base},
    history: path.join(base, 'plugin/reports'), latest: path.join(base, 'plugin/report.json')};
}
function report(index = 0) {
  return {schemaVersion: 2, pluginVersion: '0.2.2', capturedAt: '2020-01-01T00:00:00.000Z',
    requestId: 'same-request', file: 'synthetic.md', sourceSha256: 'a'.repeat(64),
    scan: {full: index % 3 === 0, complete: index % 3 === 0}, blocks: [{suspected: index % 2 === 0}], skipped: []};
}
const names = async f => (await fs.readdir(f.history)).filter(name => name.startsWith('sti-v1-'));
const ioWith = overrides => ({...fs, ...overrides});

test('19 -> 20 -> 5: mixed scopes and repeated exports; old archives retained', async t => {
  const f = await fixture(t), original = report(), saves = [];
  await fs.mkdir(f.history);
  await fs.writeFile(path.join(f.history, '2020-old.json'), JSON.stringify({...original, pluginVersion: '0.2.1'}));
  await fs.writeFile(path.join(f.history, 'manual.json'), '{"producer":"short-tail-inspector"}');
  for (let i = 0; i < 19; i++) saves.push(await saveReport(f.adapter, f.dir, report(i)));
  assert.equal((await names(f)).length, 19);
  assert(saves.every(s => !s.cleanup.triggered));
  saves.push(await saveReport(f.adapter, f.dir, original));
  assert.equal(saves[19].cleanup.deleted, 15);
  assert.equal(saves[19].cleanup.ownedCount, 5);
  assert.deepEqual((await names(f)).sort(), saves.slice(-5).map(s => path.basename(s.report.archivePath)).sort());
  assert.equal(new Set(saves.map(s => s.report.storage.saveId)).size, 20);
  assert.equal(original.archivePath, undefined);
  assert.equal(await fs.readFile(f.latest, 'utf8'), await fs.readFile(path.join(f.base, saves[19].report.archivePath), 'utf8'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.history, '2020-old.json'), 'utf8')).pluginVersion, '0.2.1');
  assert.equal(await fs.readFile(path.join(f.history, 'manual.json'), 'utf8'), '{"producer":"short-tail-inspector"}');
});

test('concurrent saves are serialized across callers; unique archives and stable latest', async t => {
  const f = await fixture(t);
  const saves = await Promise.all(Array.from({length: 20}, (_, i) => saveReport({...f.adapter}, f.dir, report(i))));
  assert.equal(saves.filter(s => s.cleanup.triggered).length, 1);
  assert.equal((await names(f)).length, 5);
  assert.equal(JSON.parse(await fs.readFile(f.latest, 'utf8')).storage.saveId, saves.at(-1).report.storage.saveId);
  assert.equal(new Set(saves.map(s => s.report.storage.savedOrder)).size, 20);
});

test('save failures never clean; failed save does not poison the queue', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 19; i++) await saveReport(f.adapter, f.dir, report(i));
  const before = await names(f);
  const broken = ioWith({rename: async () => {throw new Error('injected latest failure');}});
  await assert.rejects(saveReport(f.adapter, f.dir, report(), broken), /injected latest failure/);
  assert.deepEqual(await names(f), before);
  assert((await fs.readdir(f.history)).some(n => n.startsWith('.pending-')));
  const success = await saveReport(f.adapter, f.dir, report());
  assert.equal(success.cleanup.deleted, 15);
  assert.equal((await names(f)).length, 5);
});

test('readback mismatch and final commit failure cannot register or clean a report', async t => {
  const f = await fixture(t);
  const broken = ioWith({open: async (...args) => {
    const handle = await fs.open(...args);
    return {stat: () => handle.stat(), close: () => handle.close(), readFile: async () => 'corrupted'};
  }});
  await assert.rejects(saveReport(f.adapter, f.dir, report(), broken), /读回校验失败/);
  assert.equal((await names(f)).length, 0);
  await assert.rejects(saveReport(f.adapter, f.dir, report(), ioWith({link: async () => {throw new Error('commit failed');}})), /commit failed/);
  assert.equal((await names(f)).length, 0);
});

test('archive write failure does not replace latest or clean anything', async t => {
  const f = await fixture(t);
  await saveReport(f.adapter, f.dir, report());
  const before = await fs.readFile(f.latest, 'utf8');
  await assert.rejects(saveReport(f.adapter, f.dir, report(), ioWith({writeFile: async () => {throw new Error('write denied');}})), /write denied/);
  assert.equal(await fs.readFile(f.latest, 'utf8'), before);
  assert.equal((await names(f)).length, 1);
});

test('tampered and linked archives are excluded from count and deletion', async t => {
  const f = await fixture(t), saved = await saveReport(f.adapter, f.dir, report());
  const archived = path.join(f.base, saved.report.archivePath);
  await fs.writeFile(archived, (await fs.readFile(archived, 'utf8')).replace('synthetic.md', 'changed.md'));
  const link = path.join(f.history, 'sti-v1-1234567890000-12345678-1234-4123-8123-123456789012.json');
  await fs.symlink(archived, link);
  for (let i = 0; i < 19; i++) {
    const s = await saveReport(f.adapter, f.dir, report(i));
    assert.equal(s.cleanup.triggered, false);
  }
  const s = await saveReport(f.adapter, f.dir, report());
  assert.equal(s.cleanup.deleted, 15);
  assert.equal((await names(f)).length, 7); // five owned + modified file + symlink
  assert((await fs.lstat(link)).isSymbolicLink());
  assert((await fs.readFile(archived, 'utf8')).includes('changed.md'));
});

test('directory and latest symlinks are rejected without touching their targets', async t => {
  const f = await fixture(t), external = path.join(f.base, 'external');
  await fs.mkdir(external);
  await fs.symlink(external, f.history);
  await assert.rejects(saveReport(f.adapter, f.dir, report()), /链接/);
  assert.deepEqual(await fs.readdir(external), []);
  await fs.unlink(f.history);
  await fs.writeFile(path.join(external, 'keep.json'), 'keep');
  await fs.symlink(path.join(external, 'keep.json'), f.latest);
  await assert.rejects(saveReport(f.adapter, f.dir, report()), /普通文件/);
  assert.equal(await fs.readFile(path.join(external, 'keep.json'), 'utf8'), 'keep');
});

test('cleanup failure preserves a valid saved report and the newest five', async t => {
  const f = await fixture(t), saved = [];
  for (let i = 0; i < 19; i++) saved.push(await saveReport(f.adapter, f.dir, report(i)));
  const denied = new Set(saved.slice(0, 2).map(s => path.join(f.base, s.report.archivePath)));
  const io = ioWith({unlink: async name => {if (denied.has(name)) throw new Error('delete denied'); return fs.unlink(name);}});
  saved.push(await saveReport(f.adapter, f.dir, report(), io));
  assert.equal(saved[19].cleanup.deleted, 13);
  assert.equal(saved[19].cleanup.warnings.length, 2);
  assert.equal(saved[19].cleanup.ownedCount, 7);
  for (const s of saved.slice(-5)) assert((await fs.lstat(path.join(f.base, s.report.archivePath))).isFile());
});

test('clock rollback uses saved ordering, not original scan time', async t => {
  const f = await fixture(t), first = await saveReport(f.adapter, f.dir, report());
  const oldNow = Date.now;
  try {
    Date.now = () => 1;
    const second = await saveReport(f.adapter, f.dir, report());
    assert.equal(second.report.storage.savedOrder, first.report.storage.savedOrder + 1);
  } finally {Date.now = oldNow;}
});

test('>=20 cleanup retries after a previous deletion failure', async t => {
  const f = await fixture(t);
  const denied = ioWith({unlink: async file => {
    if (path.basename(file).startsWith('sti-v1-')) throw new Error('delete denied');
    return fs.unlink(file);
  }});
  for (let i = 0; i < 20; i++) await saveReport(f.adapter, f.dir, report(i), denied);
  assert.equal((await names(f)).length, 20);
  const next = await saveReport(f.adapter, f.dir, report());
  assert.equal(next.cleanup.triggered, true);
  assert.equal(next.cleanup.deleted, 16);
  assert.equal(next.cleanup.ownedCount, 5);
});

test('path traversal, parent links and unsupported adapters fail safely', async t => {
  const f = await fixture(t);
  await assert.rejects(saveReport(f.adapter, '../outside', report()), /安全/);
  await assert.rejects(saveReport({}, f.dir, report()), /桌面/);
  await fs.symlink(path.join(f.base, 'plugin'), path.join(f.base, 'alias'));
  await assert.rejects(saveReport(f.adapter, 'alias', report()), /链接/);
});
