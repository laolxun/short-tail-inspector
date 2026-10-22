const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
// Evaluate the actual report/UI version declaration without loading Obsidian.
const declaration = source.match(/^const VERSION=.*;$/m);
assert.ok(declaration, 'Report version declaration must be present');
const version = vm.runInNewContext(declaration[0] + '\nVERSION');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(version, manifest.version, 'Report/UI version must match the installation manifest');
console.log('Version consistency passed: ' + version);
