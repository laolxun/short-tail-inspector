// Pure existing resolver tests. Metadata is synthetic, not real Obsidian evidence.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resolveTargets} = require('../target-scan');
const position = (start, end = start) => ({start: {line: start}, end: {line: end}});
const heading = (title, level, line, end = line) => ({heading: title, level, position: position(line, end)});
function resolve(source, headings, path, other = []) {
  return resolveTargets([{kind: 'section', headingPath: path}], source, {
    headings, sections: [...headings.map(h => ({type: 'heading', position: h.position})), ...other]
  })[0];
}

test('document title is an ancestor; nested chapter includes its subsections', () => {
  const source = '# 文档\n\n## 4. 章\n\n### 小节\n正文\n\n## 5. 章\n后文';
  const headings = [heading('文档', 1, 0), heading('4. 章', 2, 2), heading('小节', 3, 4), heading('5. 章', 2, 7)];
  assert.equal(resolve(source, headings, ['4. 章']).resolved, false);
  assert.deepEqual(resolve(source, headings, ['文档', '4. 章']).ranges, [{startLine: 3, endLine: 7}]);
});

test('same title under distinct parents requires the right full path', () => {
  const source = '# A\n## 节\na\n# B\n## 节\nb';
  const headings = [heading('A', 1, 0), heading('节', 2, 1), heading('B', 1, 3), heading('节', 2, 4)];
  assert.deepEqual(resolve(source, headings, ['B', '节']).ranges, [{startLine: 5, endLine: 6}]);
});

test('duplicate complete paths return all candidates without choosing the first', () => {
  const source = '# 文档\n## 节\na\n## 节\nb';
  const result = resolve(source, [heading('文档', 1, 0), heading('节', 2, 1), heading('节', 2, 3)], ['文档', '节']);
  assert.equal(result.resolved, false);
  assert.equal(result.ranges.length, 2);
});

test('backtick and tilde code headings cannot become chapter boundaries', () => {
  const source = '# 文档\n## 4. 章\n````md\n## 伪标题\n```\n````\n~~~\n# 另一个伪标题\n~~~\n正文\n## 5. 章';
  const result = resolve(source, [heading('文档', 1, 0), heading('4. 章', 2, 1), heading('5. 章', 2, 10)], ['文档', '4. 章'],
    [{type: 'code', position: position(2, 5)}, {type: 'code', position: position(6, 8)}]);
  assert.deepEqual(result.ranges, [{startLine: 2, endLine: 10}]);
});

test('frontmatter fake headings are excluded by metadata; source lines retain their offsets', () => {
  const source = '---\ntitle: 示例\n# YAML 注释\n---\n# 文档\n## 4. 章\n正文\n## 5. 章';
  const result = resolve(source, [heading('文档', 1, 4), heading('4. 章', 2, 5), heading('5. 章', 2, 7)], ['文档', '4. 章'],
    [{type: 'yaml', position: position(0, 3)}]);
  assert.deepEqual(result.ranges, [{startLine: 6, endLine: 7}]);
});

test('simple Setext H1/H2 includes underline and excludes the next heading', () => {
  const source = '文档\n===\n\n第4章\n---\n正文\n\n第5章\n---\n后文';
  const result = resolve(source, [heading('文档', 1, 0, 1), heading('第4章', 2, 3, 4), heading('第5章', 2, 7, 8)], ['文档', '第4章']);
  assert.equal(result.resolved, true);
  assert.deepEqual(result.ranges, [{startLine: 4, endLine: 7}]);
});

test('horizontal rules are not headings and remain inside the chapter range', () => {
  const source = '# 文档\n## 4. 章\n正文\n\n---\n\n## 5. 章';
  assert.deepEqual(resolve(source, [heading('文档', 1, 0), heading('4. 章', 2, 1), heading('5. 章', 2, 6)],
    ['文档', '4. 章']).ranges, [{startLine: 2, endLine: 6}]);
});

test('EOF uses split-newline line count, including a trailing empty line', () => {
  for (const suffix of ['', '\n']) {
    const source = '# 文档\n## 4. 章\n正文' + suffix;
    assert.deepEqual(resolve(source, [heading('文档', 1, 0), heading('4. 章', 2, 1)], ['文档', '4. 章']).ranges,
      [{startLine: 2, endLine: source.split('\n').length}]);
  }
});

test('stale boundary metadata cannot produce a resolved chapter', () => {
  assert.equal(resolve('## 4. 章\n正文\n## 新章', [heading('4. 章', 2, 0), heading('旧章', 2, 2)], ['4. 章']).resolved, false);
});

test('raw CRLF ATX is conservatively unresolved by the existing source check', () => {
  const result = resolve('# 文档\r\n## 4. 章\r\n正文\r\n## 5. 章\r\n',
    [heading('文档', 1, 0), heading('4. 章', 2, 1), heading('5. 章', 2, 3)], ['文档', '4. 章']);
  assert.equal(result.resolved, false);
  assert.deepEqual(result.ranges, []);
});

test('CRLF Setext is conservatively unresolved by the existing source check', () => {
  assert.equal(resolve('文档\r\n===\r\n正文', [heading('文档', 1, 0, 1)], ['文档']).resolved, false);
});

test('explicit CRLF source line counting stays 1-based and inclusive', () => {
  const target = {kind: 'lines', startLine: 2, endLine: 3};
  const result = resolveTargets([target], '# 文档\r\n## 4. 章\r\n正文\r\n', {})[0];
  assert.deepEqual(result.ranges, [{startLine: 2, endLine: 3}]);
});
