// Migrated generic source-position regression; no chapter targets.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resolveTargets} = require('../target-scan');
test('explicit CRLF source line counting stays 1-based and inclusive', () => {
  const target = {kind: 'lines', startLine: 2, endLine: 3};
  const result = resolveTargets([target], '# 文档\r\n## 4. 章\r\n正文\r\n', {})[0];
  assert.deepEqual(result.ranges, [{startLine: 2, endLine: 3}]);
});
