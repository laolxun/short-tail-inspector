'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const queues = new Map();
const PREFIX = 'sti-v1-';
const NAME = /^sti-v1-(\d{13})-([a-f0-9-]{36})\.json$/;
const digest = text => createHash('sha256').update(text).digest('hex');

async function statOrNull(io, file) {
  try { return await io.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Hidden plugin data uses desktop filesystem APIs so links are never followed.
async function safeDirectory(io, base, relative) {
  if (!relative || relative.includes('\\') || path.isAbsolute(relative) ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('插件报告目录不是安全的库内相对路径');
  }
  let current = await io.realpath(base);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await io.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('报告目录包含链接或非目录');
  }
  return current;
}

async function readRegular(io, file) {
  const before = await io.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('报告不是普通文件');
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error('读取期间报告身份发生变化');
    }
    return {data: await handle.readFile('utf8'), stat: opened};
  } finally { await handle.close(); }
}

function ownedReport(data, relativePath, name) {
  const match = NAME.exec(name);
  if (!match) return null;
  let report;
  try { report = JSON.parse(data); } catch { return null; }
  const storage = report?.storage;
  if (!storage || storage.producer !== 'short-tail-inspector' || storage.schemaVersion !== 1 ||
      storage.saveId !== match[2] || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(storage.saveId) ||
      !Number.isSafeInteger(storage.savedOrder) || storage.savedOrder !== Number(match[1]) ||
      storage.savedAt !== new Date(storage.savedOrder).toISOString() ||
      report.archivePath !== relativePath || !Array.isArray(report.blocks) ||
      !Array.isArray(report.skipped) || typeof report.file !== 'string' || !report.scan ||
      typeof storage.contentSha256 !== 'string') return null;
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.storage.contentSha256;
  if (digest(JSON.stringify(copy, null, 2)) !== storage.contentSha256) return null;
  return {report, order: storage.savedOrder};
}

async function listOwned(io, history, relativeHistory) {
  const result = [];
  for (const name of await io.readdir(history)) {
    if (!name.startsWith(PREFIX) || !NAME.test(name)) continue;
    try {
      const {data, stat} = await readRegular(io, path.join(history, name));
      const owned = ownedReport(data, `${relativeHistory}/${name}`, name);
      if (owned) result.push({name, data, stat, ...owned});
    } catch { /* Unknown, changed, unreadable and linked files are retained. */ }
  }
  return result.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

async function saveOnce(base, dir, report, io) {
  const plugin = await safeDirectory(io, base, dir);
  const history = path.join(plugin, 'reports'), relativeHistory = `${dir}/reports`;
  if (!await statOrNull(io, history)) await io.mkdir(history);
  await safeDirectory(io, base, relativeHistory);
  const existing = await listOwned(io, history, relativeHistory);
  const savedOrder = existing.reduce((order, item) => Math.max(order, item.order + 1), Date.now());
  if (savedOrder < 0 || savedOrder > 9999999999999) throw new Error('报告保存时间异常');
  const saveId = randomUUID(), name = `${PREFIX}${String(savedOrder).padStart(13, '0')}-${saveId}.json`;
  const snapshot = JSON.parse(JSON.stringify(report));
  snapshot.archivePath = `${relativeHistory}/${name}`;
  snapshot.storage = {schemaVersion: 1, producer: 'short-tail-inspector', saveId,
    savedOrder, savedAt: new Date(savedOrder).toISOString()};
  snapshot.storage.contentSha256 = digest(JSON.stringify(snapshot, null, 2));
  const data = JSON.stringify(snapshot, null, 2);
  const pending = path.join(history, `.pending-${saveId}.json`);
  const latest = path.join(plugin, 'report.json'), temporary = path.join(plugin, `.report-${saveId}.tmp`);
  const previous = await statOrNull(io, latest);
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('最新报告路径不是普通文件');
  await io.writeFile(pending, data, {flag: 'wx'});
  await io.writeFile(temporary, data, {flag: 'wx'});
  if ((await readRegular(io, pending)).data !== data || (await readRegular(io, temporary)).data !== data) {
    throw new Error('报告暂存读回校验失败；未清理历史');
  }
  await safeDirectory(io, base, relativeHistory);
  const current = await statOrNull(io, latest);
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('最新报告路径发生变化');
  await io.rename(temporary, latest);
  if ((await readRegular(io, latest)).data !== data || (await readRegular(io, pending)).data !== data) {
    throw new Error('报告保存读回校验失败；未清理历史');
  }
  // link is an atomic, no-overwrite commit; pending names are never counted.
  await io.link(pending, path.join(history, name));
  const cleanup = {triggered: false, deleted: 0, warnings: []};
  try { await io.unlink(pending); }
  catch (error) { cleanup.warnings.push(`暂存报告保留：${error.message}`); }
  try {
    await safeDirectory(io, base, relativeHistory);
    const owned = await listOwned(io, history, relativeHistory);
    cleanup.ownedCount = owned.length;
    if (owned.length >= 20) {
      cleanup.triggered = true;
      for (const item of owned.slice(0, -5)) {
        try {
          await safeDirectory(io, base, relativeHistory);
          const now = await readRegular(io, path.join(history, item.name));
          if (now.data !== item.data || now.stat.dev !== item.stat.dev || now.stat.ino !== item.stat.ino) {
            throw new Error('报告已改变，保守保留');
          }
          await io.unlink(path.join(history, item.name));
          cleanup.deleted++;
        } catch (error) { cleanup.warnings.push(`${item.name}：${error.message}`); }
      }
      cleanup.ownedCount -= cleanup.deleted;
    }
  } catch (error) { cleanup.warnings.push(`历史清理未完成：${error.message}`); }
  return {report: snapshot, cleanup};
}

function saveReport(adapter, dir, report, io = fs) {
  if (typeof adapter.getBasePath !== 'function') return Promise.reject(new Error('安全报告保存需要桌面文件系统适配器'));
  const base = adapter.getBasePath(), key = path.resolve(base, dir);
  // Shared by all plugin instances in this Obsidian process; no durable locks/index.
  const previous = queues.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => saveOnce(base, dir, report, io));
  queues.set(key, task);
  task.finally(() => { if (queues.get(key) === task) queues.delete(key); }).catch(() => {});
  return task;
}

module.exports = {saveReport};
