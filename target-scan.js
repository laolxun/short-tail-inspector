'use strict';

const SUPPORTED = new Set(['paragraph', 'code', 'list', 'blockquote', 'heading', 'callout']);
const intersects = (a, b) => a.startLine <= b.endLine && a.endLine >= b.startLine;
const contains = (a, b) => a.startLine <= b.startLine && a.endLine >= b.endLine;
const sectionRange = section => ({startLine: section.position.start.line + 1, endLine: section.position.end.line + 1});

// A metadata label alone cannot exempt text. Require a standalone source rule,
// no overlapping metadata, and no frontmatter/fence/Setext interpretation.
function pureThematicBreak(section, lines, sections) {
  const {startLine, endLine} = sectionRange(section), line = lines[startLine - 1]?.replace(/\r$/, '');
  if (section.type !== 'thematicBreak' || startLine !== endLine ||
      !/^ {0,3}(?:\*(?:[\t ]*\*){2,}|-(?:[\t ]*-){2,}|_(?:[\t ]*_){2,})[\t ]*$/.test(line || '') ||
      sections.some(s => s !== section && intersects({startLine, endLine}, sectionRange(s)))) return false;
  let fence = null, yaml = lines[0]?.replace(/\r$/, '') === '---';
  for (let i = 0; i < startLine - 1; i++) {
    const text = lines[i].replace(/\r$/, '');
    if (yaml) {if (i > 0 && /^(---|\.\.\.)$/.test(text)) yaml = false;continue;}
    const marker = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = {char: marker[1][0], length: marker[1].length};
      else if (fence.char === marker[1][0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    }
  }
  if (yaml || fence) return false;
  // Dashes immediately following text can be a Setext underline. Be conservative.
  if (line.trim().startsWith('-') && startLine > 1 && lines[startLine - 2].trim() &&
      !/^ {0,3}#{1,6}(?:[\t ]+|$)/.test(lines[startLine - 2])) return false;
  return true;
}

function resolveTargets(input, source, cache = {}) {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error('targets 必须包含 1～100 个目标');
  const lines = source.split('\n'), sections = (cache.sections || []).filter(s => s.type !== 'yaml');
  const headings = [], stack = [];
  for (const heading of cache.headings || []) {
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
    const line = heading.position.start.line;
    const atx = (lines[line] || '').match(/^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/);
    const setext = (lines[line + 1] || '').match(/^ {0,3}(=+|-+)[\t ]*$/);
    const level = atx ? atx[1].length : setext ? (setext[1][0] === '=' ? 1 : 2) : null;
    const raw = atx ? atx[2].replace(/\s+#+\s*$/, '').trim() : (lines[line] || '').trim();
    const isHeadingSection = sections.some(s => s.type === 'heading' && s.position.start.line <= line && s.position.end.line >= line);
    const current = isHeadingSection && raw === heading.heading && level === heading.level && stack.every(h => h.current);
    const entry = {...heading, path: [...stack.map(h => h.heading), heading.heading], current};
    headings.push(entry);stack.push(entry);
  }
  return input.map((target, index) => {
    if (!target || !['section', 'paragraph', 'lines'].includes(target.kind)) throw new Error('目标 kind 必须是 section、paragraph 或 lines');
    if (target.headingPath !== undefined && (!Array.isArray(target.headingPath) || !target.headingPath.length ||
        target.headingPath.some(s => typeof s !== 'string' || !s.trim()))) throw new Error('headingPath 必须是非空标题字符串数组');
    if (target.text !== undefined && (typeof target.text !== 'string' || !target.text.trim())) throw new Error('段落 text 必须是非空源码文本');
    const explicit = target.startLine !== undefined || target.endLine !== undefined;
    let ranges = [], reason = null;
    if (explicit) {
      if (!Number.isInteger(target.startLine) || !Number.isInteger(target.endLine) ||
          target.startLine < 1 || target.endLine < target.startLine || target.endLine > lines.length) throw new Error('目标源码行必须是有效的 1-based 闭区间');
      ranges = [{startLine: target.startLine, endLine: target.endLine}];
    } else if (target.kind === 'section' && target.headingPath) {
      const matches = headings.filter(h => h.current && JSON.stringify(h.path) === JSON.stringify(target.headingPath));
      ranges = matches.map(h => {
        const next = headings.find(n => n.position.start.line > h.position.start.line && n.level <= h.level);
        if (headings.some(n => n.position.start.line > h.position.start.line &&
            (!next || n.position.start.line <= next.position.start.line) && !n.current)) reason = '章节边界缓存与源码不一致';
        return {startLine: h.position.start.line + 1, endLine: next ? next.position.start.line : lines.length};
      });
      if (matches.length !== 1) reason = '章节缺失或标题路径不唯一';
    } else if (target.kind === 'paragraph' && target.text) {
      ranges = sections.filter(s => s.type === 'paragraph' &&
        lines.slice(s.position.start.line, s.position.end.line + 1).join('\n') === target.text).map(sectionRange);
      if (ranges.length !== 1) reason = '段落缺失或源码文本不唯一';
    } else throw new Error('目标需要 startLine/endLine，或章节 headingPath，或段落 text');
    if (explicit && target.headingPath) {
      const previous = headings.filter(h => h.position.start.line < target.startLine).at(-1);
      if (!previous?.current || JSON.stringify(previous.path) !== JSON.stringify(target.headingPath)) reason = '源码行与章节路径不一致';
    }
    if (explicit && target.text && lines.slice(target.startLine - 1, target.endLine).join('\n') !== target.text) reason = '源码行与段落文本不一致';
    const expected = sections.filter(s => ranges.some(r => intersects(r, sectionRange(s))))
      .map(s => ({...sectionRange(s), type: s.type,
        ...(pureThematicBreak(s, lines, cache.sections || []) ? {textCoverage: 'excluded',
          exclusionReason: '源码与 metadata 一致的纯 thematicBreak，无文本测量义务', sourceText: lines[s.position.start.line]} : {})}));
    if (target.kind === 'paragraph' && (expected.length !== 1 || expected[0].type !== 'paragraph')) reason ||= '源码范围没有唯一对应的段落区块';
    return {index, requested: target, ranges, expected, resolved: ranges.length === 1 && !reason, resolutionReason: reason};
  });
}

function trustedSection(el, plugin, source, file, hooks) {
  const sec = hooks.sectionFor(el, plugin.contexts, source);
  if (!sec || sec.sourcePath !== file || !Number.isInteger(sec.start) || !Number.isInteger(sec.end) || sec.start < 0 || sec.end < sec.start) return null;
  // Old/absent rendering-version evidence is insufficient for targeted acceptance.
  for (let p = el; p; p = p.parentElement) {
    const record = plugin.contexts.get(p);
    if (record?.ctx) return record.info?.text === source ? sec : null;
  }
  return null;
}

// This only bounds where an unmapped node could belong; it never repairs its
// mapping. A trusted parent bounds a stale child. Otherwise, ordered render
// owners bound the source interval between them. Only anchors crossing the
// unknown node need source ordering; unrelated reorderings do not widen its scope.
// Uncertain bounds still apply to every target.
function unmappedScope(root, plugin, source, file, hooks) {
  const lineCount = source.split('\n').length;
  const owners = new Map();
  for (const [owner] of plugin.contexts) {
    if (!root.contains(owner)) continue;
    const sec = trustedSection(owner, plugin, source, file, hooks);
    if (sec && sec.owner === owner && sec.end < lineCount) owners.set(owner, sec);
  }
  const anchors = [...owners].filter(([owner]) => {
    for (let p = owner.parentElement; p && p !== root; p = p.parentElement) if (owners.has(p)) return false;
    return true;
  }).sort(([a], [b]) => a === b ? 0 : (a.compareDocumentPosition(b) & 4 ? -1 : 1));
  return el => {
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
      if (owners.has(p)) return sectionRange({position: {start: {line: owners.get(p).start}, end: {line: owners.get(p).end}}});
    }
    if (!anchors.length) return null;
    let before = null, after = null;
    for (const [owner, sec] of anchors) {
      if (owner.contains(el) || el.contains(owner)) return null;
      const position = owner.compareDocumentPosition(el);
      if (position & 4) {if (!before || sec.end > before.end) before = sec;}
      else if (position & 2) {if (!after || sec.start < after.start) after = sec;}
      else return null;
    }
    // A crossed/overlapping partition cannot place this node outside a target.
    if (before && after && before.end >= after.start) return null;
    const startLine = before ? before.end + 2 : 1;
    const endLine = after ? after.start : lineCount;
    if (startLine <= endLine) return {startLine, endLine};
    // Unexpected DOM with no source gap may belong to either bordering block.
    // Keep both in its conservative scope instead of exempting an empty range.
    return before && after ? {startLine: before.start + 1, endLine: after.end + 1} : null;
  };
}

function renderGroups(root, plugin, source, file, hooks, wantedRanges) {
  const groups = new Map();
  const cache = plugin.app.metadataCache.getFileCache(plugin.app.vault.getAbstractFileByPath?.(file) || {path:file}) || {};
  const scope = unmappedScope(root, plugin, source, file, hooks), mappingGaps = [];
  const unknown = (el, kind, fromHrBranch = false) => {
    const possibleRange = scope(el), gap = {kind, possibleRange};
    if (possibleRange === null) {
      const nodeClass = node => node?.getAttribute?.('class') ?? (typeof node?.className === 'string' ? node.className : '');
      const parent = el.parentElement;
      let sourceContainerRange = null;
      for (let node = el; node && node !== root; node = node.parentElement) {
        let section;
        try { section = hooks.sectionFor(node, plugin.contexts, source); } catch {}
        if (section?.sourcePath === file && Number.isInteger(section.start) && Number.isInteger(section.end) &&
            section.start >= 0 && section.end >= section.start && section.end < source.split('\n').length) {
          sourceContainerRange = {startLine: section.start + 1, endLine: section.end + 1};
          break;
        }
      }
      gap.diagnostic = {
        tagName: el.tagName || '', className: nodeClass(el),
        parentTagName: parent?.tagName || '', parentClassName: nodeClass(parent),
        textContentSummary: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        fromHrBranch, sourceContainerRange
      };
    }
    // DOM identity is internal evidence; never serialize a DOM node into reports.
    Object.defineProperty(gap, 'node', {value: el});
    mappingGaps.push(gap);
  };
  const get = el => {
    const sec = trustedSection(el, plugin, source, file, hooks);
    if (!sec) return null;
    if (!wantedRanges.some(r => intersects(r, {startLine: sec.start + 1, endLine: sec.end + 1}))) return false;
    const key = `${sec.start}:${sec.end}`;
    if (!groups.has(key)) groups.set(key, {...sectionRange({position: {start: {line: sec.start}, end: {line: sec.end}}}), owners: new Set(), nodes: new Map(), headings: [], unsupported: [], callouts: new Set(), calloutIssues: []});
    const group = groups.get(key);group.owners.add(sec.owner);
    return {group, sec};
  };
  for (const el of root.querySelectorAll(hooks.SELECTOR)) {
    if (el.closest('table,.frontmatter,.metadata-container,.markdown-embed') ||
        (el.tagName === 'P' && el.closest('pre')) || (el.tagName === 'LI' && el.querySelector(':scope > p'))) continue;
    const found = get(el);
    // Unmapped text could belong to a target; it cannot be silently excluded.
    if (!found) {if (found === null && el.textContent.trim()) unknown(el, 'text');continue;}
    if (/^H[1-6]$/.test(el.tagName)) found.group.headings.push(el);
    else {
      found.group.nodes.set(`${found.sec.start}:${found.sec.end}:${hooks.elementPath(el, found.sec.owner)}`, el);
      const clipping = [];
      for (let ancestor = el; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
        const style = root.ownerDocument.defaultView.getComputedStyle(ancestor);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY + style.overflowX)) clipping.push({ancestor, style});
      }
      if (clipping.length) {
        const range = el.ownerDocument.createRange();range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
        for (const {ancestor, style} of clipping) {
          const box = ancestor.getBoundingClientRect();
          if ((/(auto|scroll|hidden|clip)/.test(style.overflowY) && rects.some(r => r.top < box.top || r.bottom > box.bottom)) ||
              (/(auto|scroll|hidden|clip)/.test(style.overflowX) && rects.some(r => r.left < box.left || r.right > box.right))) {
          found.group.unsupported.push(el);break;
          }
        }
      }
    }
  }
  for (const el of root.querySelectorAll('table,.markdown-embed,.callout.is-collapsed,img,svg,canvas,.mermaid')) {
    if (el.closest('.frontmatter,.metadata-container,.callout-icon,.callout-fold,.collapse-indicator,.heading-collapse-indicator,button,.copy-code-button,.sr-only')) continue;
    const found = get(el);
    if (found) found.group.unsupported.push(el);
    else if (found === null) unknown(el, 'unsupported');
  }
  for (const el of root.querySelectorAll('.callout')) {
    if (el.closest('.markdown-embed')) continue;
    const found = get(el);
    if (found) {
      found.group.callouts.add(el);
      const section = (cache.sections || []).filter(s => sectionRange(s).startLine === found.sec.start + 1 && sectionRange(s).endLine === found.sec.end + 1);
      if (section.length !== 1 || !['callout', 'list'].includes(section[0].type)) found.group.calloutIssues.push('Callout 子范围缺少可信区块 metadata');
      else if (section[0].type === 'callout') found.group.calloutIssues.push(...calloutIssues(el, found.sec, source));
    } else if (found === null) unknown(el, 'unsupported');
  }
  for (const group of groups.values()) {
    const section = (cache.sections || []).filter(s => sectionRange(s).startLine === group.startLine && sectionRange(s).endLine === group.endLine);
    if (section.length !== 1 || section[0].type !== 'list') continue;
    const sec = {start: group.startLine - 1, end: group.endLine - 1};
    const owners = Array.from(group.owners);
    const lists = owners.flatMap(owner => Array.from(owner.querySelectorAll('ul,ol'))).filter(node => {
      const mapped = trustedSection(node, plugin, source, file, hooks);
      return mapped && mapped.start === sec.start && mapped.end === sec.end;
    });
    const mappings = lists.length === 1 ? nestedCalloutMappings(lists[0], sec, source, plugin, file, hooks, cache) : null;
    if (!mappings || [...group.callouts].some(el => !mappings.has(el))) {
      group.calloutIssues.push('Callout 子范围无法从唯一可信列表映射中确定');
      continue;
    }
    for (const [el, child] of mappings) group.calloutIssues.push(...calloutIssues(el, child, source));
  }
  // Inspect any instantiated separator owner too: a source-only exemption must
  // never hide unexpected rendered text, even outside the scanner selector.
  for (const el of root.querySelectorAll('hr')) {
    const found = get(el);
    if (found && found.sec.owner.textContent.trim()) found.group.unsupported.push(el);
    else if (found === null && el.parentElement?.textContent.trim()) unknown(el, 'text', true);
  }
  return {groups, mappingGaps};
}

const normalizedText = text => text.replace(/\s+/g, ' ').trim();

// Recover only the narrow list shape that can be proved from source metadata
// and the rendered DOM. Anything beyond flat list items with fully quoted
// callouts stays uncovered; this is deliberately not a Markdown parser.
function nestedCalloutMappings(list, sec, source, plugin, file, hooks, cache) {
  const metadata = (cache.sections || []).filter(s => s.type === 'list' &&
    sectionRange(s).startLine === sec.start + 1 && sectionRange(s).endLine === sec.end + 1);
  const mapped = trustedSection(list, plugin, source, file, hooks);
  if (metadata.length !== 1 || metadata[0].type !== 'list' || !mapped || mapped.start !== sec.start || mapped.end !== sec.end ||
      list.querySelector('ul ul,ul ol,ol ul,ol ol')) return null;

  const lines = source.split('\n').slice(sec.start, sec.end + 1).map(line => line.replace(/\r$/, ''));
  const items = [];
  let baseIndent = null, listKind = null, delimiter = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^( {0,3})([-+*]|([0-9]{1,9})([.)]))([ ]+)(.*)$/);
    if (!match) continue;
    const indent = match[1].length, kind = match[3] ? 'ordered' : 'bullet', mark = match[2];
    if (baseIndent === null) {baseIndent = indent;listKind = kind;delimiter = match[4] || mark;}
    if (indent !== baseIndent || kind !== listKind || kind === 'bullet' && mark !== delimiter ||
        kind === 'ordered' && match[4] !== delimiter) return null;
    items.push({start: i, contentIndent: indent + mark.length + match[5].length,
      end: lines.length - 1, callouts: []});
  }
  if (!items.length) return null;
  for (let i = 0; i < items.length - 1; i++) items[i].end = items[i + 1].start - 1;
  const directItems = Array.from(list.children).filter(node => node.tagName === 'LI');
  if (directItems.length !== items.length) return null;
  for (const item of items) {
    for (let i = item.start + 1; i <= item.end; i++) {
      const marker = lines[i].match(new RegExp(`^ {${item.contentIndent}}>[\\t ]?\\[![^\\]\\r\\n]+\\][+-]?(?:[\\t ].*)?$`));
      if (!marker) continue;
      let end = i;
      while (end + 1 <= item.end && new RegExp(`^ {${item.contentIndent}}>[\\t ]?(.*)$`).test(lines[end + 1])) end++;
      item.callouts.push({start: sec.start + i, end: sec.start + end});
      i = end;
    }
  }
  const result = new Map();
  for (let i = 0; i < directItems.length; i++) {
    const rendered = Array.from(directItems[i].querySelectorAll('.callout')).filter(node => node.closest('li') === directItems[i]);
    if (rendered.length !== items[i].callouts.length) return null;
    for (let j = 0; j < rendered.length; j++) result.set(rendered[j], items[i].callouts[j]);
  }
  return result;
}

function hasDisplayNoneAncestor(el) {
  const win = el.ownerDocument.defaultView;
  for (let p = el; p; p = p.parentElement) if (win.getComputedStyle(p).display === 'none') return true;
  return false;
}

// Decode exactly one CSS string, never attr(), counters, URLs or mixed content.
// Unknown syntax remains a coverage obligation; zero-width boxes are not proof.
function cssString(content) {
  const quote = content[0];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let i = 1; i < content.length; i++) {
    const char = content[i];
    if (char === quote) return i === content.length - 1 ? value : null;
    if (/[\n\r\f]/.test(char)) return null;
    if (char !== '\\') {value += char;continue;}
    const hex = content.slice(i + 1).match(/^[\da-fA-F]{1,6}/);
    if (hex) {
      const code = parseInt(hex[0], 16);
      if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
      value += String.fromCodePoint(code);i += hex[0].length;
      if (/[\t\n\r\f ]/.test(content[i + 1] || '\uFFFF')) {
        i++;if (content[i] === '\r' && content[i + 1] === '\n') i++;
      }
    } else {
      const next = content[++i];
      if (next == null || /[\n\r\f]/.test(next)) return null;
      value += next;
    }
  }
  return null;
}

function calloutNodePath(el, root) {
  const parts = [];
  for (let node = el; node; node = node.parentElement) {
    parts.unshift(node.localName + (node === root ? '' : `:nth-child(${Array.from(node.parentElement.children).indexOf(node) + 1})`));
    if (node === root) break;
  }
  return parts.join(' > ');
}

function hasVisibleText(el) {
  const win = el.ownerDocument.defaultView;
  if (hasDisplayNoneAncestor(el)) return false;
  const walker = el.ownerDocument.createTreeWalker(el, 4);
  let text;
  while ((text = walker.nextNode())) {
    if (!text.nodeValue.trim() || win.getComputedStyle(text.parentElement).visibility !== 'visible') continue;
    const range = el.ownerDocument.createRange();range.selectNodeContents(text);
    if (Array.from(range.getClientRects()).some(r => r.width > 0 && r.height > 0)) return true;
  }
  return false;
}

// Narrow, fail-closed proof for plain quoted paragraphs. Do not invent a second
// Markdown renderer: richer bodies remain measurable candidates but uncovered.
function calloutIssues(el, sec, source) {
  const issues = [], lines = source.split('\n').slice(sec.start, sec.end + 1).map(s => s.replace(/\r$/, ''));
  if (!/^ {0,3}>[\t ]?\[![^\]\r\n]+\][+-]?(?:[\t ].*)?$/.test(lines[0] || '')) issues.push('Callout 源码标记无法核对');
  const body = [];
  for (const line of lines.slice(1)) {
    const match = line.match(/^ {0,3}>[\t ]?(.*)$/);
    if (!match && line.trim()) issues.push('Callout 正文源码范围不可信');
    body.push(match ? match[1] : '');
  }
  if (body.some(line => /^\s*(?:[>#]|[-+*]\s|\d+[.)]\s|`{3}|~{3}| {4}|\t)/.test(line) || /[`*_[\]<>\\&]|!\[|\|/.test(line))) issues.push('Callout 复杂正文尚无完整文本映射证明');
  const paragraphs = body.join('\n').trim().split(/\n[\t ]*\n+/).map(normalizedText).filter(Boolean);
  const content = el.querySelector(':scope > .callout-content');
  const nodes = content ? Array.from(content.querySelectorAll('p')) : [];
  if (!content || !paragraphs.length || nodes.length !== paragraphs.length ||
      nodes.some((p, i) => normalizedText(p.textContent) !== paragraphs[i]) ||
      content.textContent.replace(/\s/g, '') !== paragraphs.join('').replace(/\s/g, '')) issues.push('Callout 正文节点或源码文本不完整');
  if (content?.querySelector('pre,li,blockquote,.callout,table,.markdown-embed,h1,h2,h3,h4,h5,h6')) issues.push('Callout 正文结构无法完整核对');
  for (const title of el.querySelectorAll(':scope > .callout-title')) {
    if (hasVisibleText(title)) issues.push('Callout 可见标题未纳入文本测量');
  }
  const extra = el.ownerDocument.createTreeWalker(el, 4);
  let extraText;
  while ((extraText = extra.nextNode())) {
    if (!content?.contains(extraText) && !extraText.parentElement.closest('.callout-title,.callout-icon,.callout-fold') &&
        extraText.nodeValue.trim() && hasVisibleText(extraText.parentElement)) issues.push('Callout 含未测容器文本');
  }
  // Every non-space body character needs geometry, even if its paragraph has
  // other visible characters (display:none spans cannot count as measured).
  for (const p of nodes) {
    if (p.textContent.length > 12000) {issues.push('Callout 正文超过测量上限');continue;}
    const walker = p.ownerDocument.createTreeWalker(p, 4);
    let text;
    while ((text = walker.nextNode())) for (const part of new Intl.Segmenter('zh', {granularity: 'grapheme'}).segment(text.nodeValue)) {
      if (!part.segment.trim()) continue;
      const range = p.ownerDocument.createRange();range.setStart(text, part.index);range.setEnd(text, part.index + part.segment.length);
      if (p.ownerDocument.defaultView.getComputedStyle(text.parentElement).visibility !== 'visible' ||
          !Array.from(range.getClientRects()).some(r => r.width > 0 && r.height > 0) || text.parentElement.closest('button,script,style,.copy-code-button,.sr-only')) issues.push('Callout 正文含不可见或未测字符');
    }
  }
  for (const node of [el, ...el.querySelectorAll('*')]) {
    // This exemption concerns generated content only. Hidden/missing body text
    // still fails the independent source, geometry and measurement checks above.
    if (hasDisplayNoneAncestor(node)) continue;
    for (const pseudo of ['::before', '::after']) {
      const style = el.ownerDocument.defaultView.getComputedStyle(node, pseudo);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || ['none', 'normal'].includes(style.content)) continue;
      const value = cssString(style.content);
      // Only CSS whitespace and the U+200B layout placeholder are exempt.
      // Do not broaden this to format controls, invisible glyphs or icon classes.
      if (value !== null && /^[\t\n\r\f \u200B]*$/.test(value)) continue;
      issues.push(`Callout 含未测生成内容（节点 ${calloutNodePath(node, el)}${pseudo}，content=${JSON.stringify(style.content)}；${value === null ? '未知生成内容无法证明无文本义务' : '非纯排版占位，尚未测量'}）`);
    }
  }
  return [...new Set(issues)];
}

function viewportFor(root) {
  const box = root.getBoundingClientRect(), win = root.ownerDocument.defaultView;
  return {top: Math.max(0, box.top + root.clientTop), left: Math.max(0, box.left + root.clientLeft),
    bottom: Math.min(win.innerHeight, box.top + root.clientTop + root.clientHeight),
    right: Math.min(win.innerWidth, box.left + root.clientLeft + root.clientWidth)};
}

function fullyVisible(el, root) {
  const win = root.ownerDocument.defaultView, bounds = viewportFor(root);
  for (let ancestor = el.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
    const style = win.getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { bounds.top = Math.max(bounds.top, rect.top);bounds.bottom = Math.min(bounds.bottom, rect.bottom); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { bounds.left = Math.max(bounds.left, rect.left);bounds.right = Math.min(bounds.right, rect.right); }
  }
  const inside = rect => rect.width > 0 && rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right;
  const style = win.getComputedStyle(el);
  if (style.display === 'none' || style.visibility !== 'visible' || !inside(el.getBoundingClientRect())) return false;
  const range = el.ownerDocument.createRange();range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
  return rects.length > 0 && rects.every(inside);
}

class TargetTracker {
  constructor(targets, plugin, source, file, hooks) {
    Object.assign(this, {targets, plugin, source, file, hooks});
    this.ranges = targets.flatMap(target => target.ranges);
    this.groups = new Map();this.measured = new Set();this.failed = new Set();this.mappingGaps = new Map();this.gapKeys = new WeakMap();
    this.headingSnapshots = [];this.sectionSnapshots = new Map();this.renderedSections = new Map();
  }
  observe(root, result) {
    this.root = root;
    // Immutable observations survive virtual rendering and DOM node reuse.
    // Never use detached nodes as current boundary owners.
    try {
      if (this.targets.some(target => target.requested.kind === 'section')) {
        const state = {step: this.headingSnapshots.length + 1, scrollTop: root.scrollTop,
          scrollHeight: root.scrollHeight, clientHeight: root.clientHeight};
        const candidates = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')]
          .filter(el => !el.closest('.frontmatter,.metadata-container,.markdown-embed'))
          .map((el, domIndex) => ({tagName: el.tagName, textContent: el.textContent,
            level: Number(el.tagName.slice(1)), domIndex, domPath: this.hooks.elementPath(el, root)}));
        this.headingSnapshots.push({state, candidates});
        for (const target of this.targets) {
          if (target.requested.kind !== 'section') continue;
          const plan = this.liveSectionPlanDiagnostic(target);
          const snapshots = this.sectionSnapshots.get(target.index) || [];
          snapshots.push({...plan, scanState: state});
          this.sectionSnapshots.set(target.index, snapshots);
        }
      }
    } catch {
      // Diagnostic failures cannot change scanning or acceptance.
      this.headingEvidenceFailed = true;
    }
    const current = renderGroups(root, this.plugin, this.source, this.file, this.hooks, this.ranges);
    for (const gap of current.mappingGaps) {
      const node = gap.node;
      let keys = this.gapKeys.get(node);
      if (!keys) this.gapKeys.set(node, keys = new Map());
      const identity = JSON.stringify([gap.kind, node.textContent]);
      let key = keys.get(identity);
      if (!key || !this.sameGapPosition(key, root)) {
        const position = [];
        for (let el = node; el && el !== root; el = el.parentElement) {
          position.push({el, parent: el.parentElement, before: el.previousSibling, after: el.nextSibling});
        }
        key = {node, root, position, text: node.textContent};
        keys.set(identity, key);
        this.mappingGaps.set(key, {...gap, state: gap.possibleRange ? 'located' : 'pending'});
      } else {
        const previous = this.mappingGaps.get(key);
        // A moved/reused node cannot retroactively locate its earlier obligation.
        if (this.sameGapPosition(key, root)) {
          this.mappingGaps.set(key, {...previous, ...gap,
            state: gap.possibleRange ? 'located' : 'pending'});
        }
      }
    }
    const scope = unmappedScope(root, this.plugin, this.source, this.file, this.hooks);
    for (const [key, gap] of this.mappingGaps) {
      if (gap.possibleRange || !this.sameGapPosition(key, root)) continue;
      const section = trustedSection(key.node, this.plugin, this.source, this.file, this.hooks);
      const range = section && section.end < this.source.split('\n').length
        ? {startLine: section.start + 1, endLine: section.end + 1} : scope(key.node);
      if (range) this.mappingGaps.set(key, {...gap, possibleRange: range, state: 'located'});
    }
    // Bind obligations while their original DOM identity/position is still
    // valid. Detached or recycled nodes cannot acquire retrospective immunity.
    for (const target of this.targets) {
      if (target.requested.kind !== 'section') continue;
      let plan;
      try { plan = this.sectionPlan(target, root); } catch { continue; }
      if (plan.status !== 'ready') continue;
      for (const [key] of this.mappingGaps) {
        if (!this.sameGapPosition(key, root)) continue;
        const node = key.node, start = plan.startOwner, end = plan.endOwner;
        let relation = null;
        if (start === node || start.contains(node)) relation = 'inside';
        else if (node.contains(start) || node.contains(end)) continue;
        else if (end === node || end.contains(node)) relation = 'outside';
        else if ((start.compareDocumentPosition(node) & 4) && (node.compareDocumentPosition(end) & 4)) relation = 'inside';
        else if ((node.compareDocumentPosition(start) & 4) || (end.compareDocumentPosition(node) & 4)) relation = 'outside';
        if (!relation) continue;
        if (!key.sectionMembership) key.sectionMembership = new Map();
        const evidence = key.sectionMembership.get(target.index) || new Set();
        evidence.add(relation);key.sectionMembership.set(target.index, evidence);
      }
    }
    for (const [key, group] of current.groups) {
      const previous = this.groups.get(key);
      if (previous) {
        for (const [k, el] of group.nodes) previous.nodes.set(k, el);
        for (const owner of group.owners) previous.owners.add(owner);
        previous.headings.push(...group.headings);previous.unsupported.push(...group.unsupported);
        for (const el of group.callouts) previous.callouts.add(el);
        previous.calloutIssues.push(...group.calloutIssues);
      } else this.groups.set(key, group);
    }
    for (const target of this.targets) {
      if (target.requested.kind !== 'section') continue;
      let plan;
      try { plan = this.sectionPlan(target, root); } catch { continue; }
      const snapshots = this.renderedSections.get(target.index) || [];
      if (plan?.status === 'ready' && !snapshots.length) {
        const entries = [];
        for (let owner = plan.startOwner; owner && owner !== plan.endOwner; owner = owner.nextSibling) {
          if (owner.nodeType !== 1) {if (owner.textContent.trim()) entries.push({type: 'unknown', nodes: []});continue;}
          const content = owner.matches('h1,h2,h3,h4,h5,h6,p,pre,blockquote,ul,ol,table,hr,.callout')
            ? owner : owner.querySelector('h1,h2,h3,h4,h5,h6') || owner.firstElementChild;
          const type = content?.matches('.callout') ? 'callout' : content?.matches('h1,h2,h3,h4,h5,h6') ? 'heading' :
            content?.matches('p') ? 'paragraph' : content?.matches('pre') ? 'code' : content?.matches('blockquote') ? 'blockquote' :
            content?.matches('ul,ol') ? 'list' : content?.matches('hr') ? 'thematicBreak' : content?.matches('table') ? 'table' : 'unknown';
          const candidates = [owner, ...owner.querySelectorAll(this.hooks.SELECTOR)].filter(el =>
            el.matches(this.hooks.SELECTOR) && !/^H[1-6]$/.test(el.tagName) &&
            !el.closest('table,.frontmatter,.metadata-container,.markdown-embed') &&
            !(el.tagName === 'P' && el.closest('pre')) && !(el.tagName === 'LI' && el.querySelector(':scope > p')));
          const nodes = candidates.map(node => {
            const position = [];
            for (let el = node; el && el !== root; el = el.parentElement)
              position.push({el, parent: el.parentElement, before: el.previousSibling, after: el.nextSibling});
            return {node, root, position, text: node.textContent, measured: null,
              domPath: this.hooks.elementPath(node, root)};
          });
          entries.push({type, owner, nodes});
        }
        snapshots.push({entries});this.renderedSections.set(target.index, snapshots);
      }
      for (const snapshot of snapshots) for (const entry of snapshot.entries) for (const record of entry.nodes) {
        if (!this.sameGapPosition(record, root)) continue;
        const block = result.blocks.find(block => block.renderNode === record.node);
        if (block) record.measured = block;
      }
    }
    for (const block of result.blocks) if (block.key) this.measured.add(block.key);
    for (const skipped of result.skipped) if (skipped.key) this.failed.add(skipped.key);
  }
  sameGapPosition(key, root) {
    const node = key.node;
    return key.root === root && root.contains(node) && node.textContent === key.text &&
      key.position.every(({el, parent, before, after}) => el.parentElement === parent &&
        el.previousSibling === before && el.nextSibling === after);
  }
  gapsFor(target, gaps = [...this.mappingGaps.values()]) {
    return gaps.filter(gap => gap.sectionRelation === 'inside' ||
      (gap.sectionRelation !== 'outside' && (!gap.possibleRange || target.ranges.some(r => intersects(r, gap.possibleRange)))));
  }
  reasons(target, groups = this.groups, requireMeasured = true, gaps = [...this.mappingGaps.values()]) {
    const reasons = [];
    if (!target.resolved) reasons.push(target.resolutionReason || '目标没有唯一可信范围');
    if (!target.expected.length) reasons.push('目标没有可核对的源区块');
    for (const group of groups.values()) {
      if (target.ranges.some(r => intersects(r, group)) && !target.expected.some(s => s.startLine === group.startLine && s.endLine === group.endLine)) reasons.push('目标存在无法与缓存源区块核对的渲染范围');
    }
    let measuredCount = 0;
    for (const section of target.expected) {
      const group = groups.get(`${section.startLine - 1}:${section.endLine - 1}`);
      if (section.textCoverage === 'excluded') {
        if (group && (group.nodes.size || group.headings.length || group.unsupported.length || group.callouts.size)) reasons.push('纯分隔线出现非预期渲染内容');
        continue;
      }
      if (!SUPPORTED.has(section.type)) reasons.push(`未支持的源区块：${section.type}`);
      if (!group) {reasons.push(`源区块 ${section.startLine}～${section.endLine} 缺少可信渲染映射`);continue;}
      reasons.push(...group.calloutIssues.map(reason => `源区块 ${section.startLine}～${section.endLine}：${reason}`));
      if (section.type === 'callout' && group.callouts.size !== 1) reasons.push('Callout 缺少唯一可信容器');
      if (group.unsupported.length) reasons.push('目标含表格、折叠、嵌入或图形等未测内容');
      // Multiple render owners can reuse paths; never accept such deduplication as proof.
      if (group.owners.size !== 1) reasons.push('源区块的渲染归属不唯一');
      if (group.nodes.size > 1 && !target.ranges.some(r => contains(r, group))) reasons.push('部分源码范围不能可靠对应区块内多个段落');
      if (section.type !== 'heading' && !group.nodes.size) reasons.push('源区块没有可测文本');
      for (const key of group.nodes.keys()) {
        measuredCount++;
        if (requireMeasured && (!this.measured.has(key) || this.failed.has(key))) reasons.push('目标文本块未成功测量');
      }
    }
    if (!measuredCount) reasons.push('目标没有可测文本');
    const relevantGaps = this.gapsFor(target, gaps);
    if (relevantGaps.some(gap => gap.kind === 'unsupported')) reasons.push('目标内或无法排除属于目标的未支持渲染内容');
    if (relevantGaps.some(gap => gap.kind === 'text')) reasons.push('目标内或无法排除属于目标的文本缺少可信源码映射');
    return [...new Set(reasons)];
  }
  renderedSectionResult(target, gaps) {
    const snapshot = this.renderedSections.get(target.index)?.[0];
    const reasons = [], blocks = [];
    if (!snapshot) return {reasons: ['章节 DOM 内容检测证据缺失'], blocks, mappingPrecision: 'partial'};
    const expected = target.expected;
    const entries = snapshot.entries;
    const relevantGaps = this.gapsFor(target, gaps);
    const gapNodes = relevantGaps.map(gap => gap.node).filter(Boolean);
    const belongsToGap = node => !!node && gapNodes.some(gapNode => gapNode === node || gapNode.contains?.(node) || node.contains?.(gapNode));
    const hasMappingGaps = relevantGaps.length > 0;
    if (relevantGaps.some(gap => gap.kind === 'unsupported')) reasons.push('章节含未支持或无法检测的渲染内容');
    if (!hasMappingGaps && (entries.length !== expected.length || entries.some((entry, i) => entry.type !== expected[i]?.type)))
      reasons.push('章节预期区块缺失或渲染结构／顺序异常');
    let partial = hasMappingGaps;
    for (const [index, entry] of entries.entries()) {
      const block = expected[index];
      if ((entry.type === 'unknown' && !belongsToGap(entry.owner)) ||
          (entry.type !== 'unknown' && !SUPPORTED.has(entry.type) && entry.type !== 'thematicBreak'))
        reasons.push('章节含未支持或无法检测的渲染内容');
      if (entry.type === 'heading' || (entry.type === 'thematicBreak' && block?.textCoverage === 'excluded')) continue;
      if (!entry.nodes.length) reasons.push('章节内部节点完全无法检测');
      for (const record of entry.nodes) {
        if (!record.measured) {
          if (!belongsToGap(record.node)) reasons.push('章节内部节点未成功检测');
          continue;
        }
        const measured = record.measured;
        if (!measured.lineCount || measured.measurementUnit?.complete === false) reasons.push('章节内部存在隐藏、未测或异常渲染文本');
        const exact = block && measured.sourceStartLine === block.startLine && measured.sourceEndLine === block.endLine;
        partial ||= !exact;
        blocks.push({...measured, sectionDomPath: record.domPath, mappingPrecision: exact ? 'exact' : 'partial'});
      }
      const walker = entry.owner.ownerDocument.createTreeWalker(entry.owner, 4);
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (!textNode.nodeValue.trim() || textNode.parentElement.closest('button,script,style,.copy-code-button,.sr-only,.callout-title,.callout-icon,.callout-fold')) continue;
        if (!entry.nodes.some(record => record.node.contains(textNode) && record.measured) && !belongsToGap(textNode.parentElement))
          reasons.push('章节内部有未参与检测的文本节点');
      }
      for (const group of this.groups.values()) {
        if (![...group.owners].some(owner => owner === entry.owner || entry.owner.contains(owner))) continue;
        if (group.unsupported.some(node => node === entry.owner || entry.owner.contains(node)) ||
            (group.calloutIssues.length && [...group.callouts].some(node => entry.owner.contains(node))))
          reasons.push('章节含未支持内容或明确渲染异常');
      }
      if (entry.type === 'callout' && ![...this.groups.values()].some(group => group.callouts.size === 1 &&
          [...group.owners].some(owner => owner === entry.owner || entry.owner.contains(owner))))
        reasons.push('Callout 内容检测完整性无法确认');
    }
    // A trusted section boundary plus successful rendered measurements is
    // sufficient for coverage. Keep source mapping gaps as precision data.
    if (hasMappingGaps) partial = true;
    if (!blocks.length) reasons.push('目标没有可测文本');
    return {reasons: [...new Set(reasons)], blocks, mappingPrecision: partial ? 'partial' : 'exact'};
  }
  async localize(view) {
    if (this.targets.length !== 1 || !this.targets[0].resolved) return false;
    const root = view.containerEl.querySelector('.markdown-preview-view');
    let current = renderGroups(root, this.plugin, this.source, this.file, this.hooks, this.ranges);
    if (this.reasons(this.targets[0], current.groups, false, current.mappingGaps).length) return false;
    const elements = () => this.targets[0].expected.flatMap(s => {
      const group = current.groups.get(`${s.startLine - 1}:${s.endLine - 1}`);
      return group ? [...group.nodes.values(), ...group.headings] : [];
    });
    let nodes = elements(), rects = nodes.map(el => el.getBoundingClientRect());
    const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom));
    if (bottom - top > root.clientHeight) return false;
    const viewport = viewportFor(root);
    if (!nodes.every(el => fullyVisible(el, root))) {
      root.scrollTop += (top + bottom - viewport.top - viewport.bottom) / 2;
      await this.hooks.settleLayout(root);
    }
    if (view.containerEl.querySelector('.markdown-preview-view') !== root) return false;
    current = renderGroups(root, this.plugin, this.source, this.file, this.hooks, this.ranges);
    if (this.reasons(this.targets[0], current.groups, false, current.mappingGaps).length) return false;
    nodes = elements();
    return nodes.length > 0 && nodes.every(el => fullyVisible(el, root));
  }
  sectionPlan(target, root) {
    const plan = {sourceRange: target.ranges.length === 1 ? {...target.ranges[0]} : null,
      expectedBlocks: target.expected.map(block => ({...block})), startOwner: null, endOwner: null,
      startHeading: null, endHeading: null, orderPassed: null,
      sectionDomRange: null, boundaryEvidence: null, contentNodesUnchecked: [], status: 'unavailable', reason: null};
    const fail = reason => {plan.reason = reason;return plan;};
    if (target.requested.kind !== 'section' || !target.requested.headingPath) return fail('仅支持 headingPath 章节目标');
    if (!target.resolved || !plan.sourceRange) return fail(target.resolutionReason || '章节未唯一解析');
    if (!root || root !== this.root || !root.isConnected) return fail('当前阅读视图不存在或已失效');
    const cache = this.plugin.app.metadataCache.getFileCache(this.plugin.app.vault.getAbstractFileByPath?.(this.file) || {path: this.file}) || {};
    const range = plan.sourceRange;
    const sourceHeadings = cache.headings || [];
    const starts = sourceHeadings.filter(h => h.position.start.line + 1 === range.startLine);
    const ends = sourceHeadings.filter(h => h.position.start.line === range.endLine);
    if (starts.length !== 1) return fail('开始标题 metadata 不唯一');
    if (!ends.length) return fail('结束边界不存在；暂不支持 document-end');
    if (ends.length !== 1 || ends[0].level > starts[0].level) return fail('结束标题不是唯一同级或更高层级边界');
    const sections = cache.sections || [];
    const sectionAt = h => sections.filter(s => s.type === 'heading' && s.position.start.line === h.position.start.line);
    if (sectionAt(starts[0]).length !== 1 || sectionAt(ends[0]).length !== 1) return fail('开始或结束标题缺少唯一源区块');

    // A rendered heading may have no MarkdownPostProcessorContext. Bind it to
    // metadata only when text and level are unique in both source and DOM.
    const domHeadings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(el =>
      !el.closest('.frontmatter,.metadata-container,.markdown-embed') && root.contains(el));
    const ownerOf = el => {
      const parent = el.parentElement;
      return parent && parent !== root && parent.querySelectorAll('h1,h2,h3,h4,h5,h6').length === 1 &&
        parent.textContent.trim() === el.textContent.trim() ? parent : el;
    };
    const identify = heading => {
      const text = heading.heading, tagName = `H${heading.level}`;
      const sourceMatches = sourceHeadings.filter(h => h.heading === text && h.level === heading.level);
      const textMatches = domHeadings.filter(el => el.textContent.trim() === text);
      const levelMatches = domHeadings.filter(el => el.tagName === tagName);
      const exact = textMatches.filter(el => el.tagName === tagName);
      const evidence = {domFound: textMatches.length > 0, textMatches: textMatches.length > 0,
        levelMatches: exact.length > 0, sourceUnique: sourceMatches.length === 1,
        sameLevelCandidates: levelMatches.length, domMatches: exact.length, sourceRange: {startLine: heading.position.start.line + 1,
          endLine: heading.position.start.line + 1}, reason: null};
      if (sourceMatches.length !== 1) evidence.reason = '源码存在重复的同级同名标题';
      else if (!textMatches.length) evidence.reason = 'DOM 标题文本不匹配或标题未渲染';
      else if (!exact.length) evidence.reason = 'DOM 标题层级不匹配';
      else if (exact.length !== 1) evidence.reason = 'DOM 存在重复的同级同名标题';
      return {evidence, node: evidence.reason ? null : exact[0], owner: evidence.reason ? null : ownerOf(exact[0])};
    };
    const startMatch = identify(starts[0]), endMatch = identify(ends[0]);
    plan.startHeading = startMatch.evidence;plan.endHeading = endMatch.evidence;
    plan.startOwner = startMatch.owner;plan.endOwner = endMatch.owner;
    if (startMatch.evidence.reason || endMatch.evidence.reason)
      return fail(`开始标题：${startMatch.evidence.reason || '匹配'}；结束标题：${endMatch.evidence.reason || '匹配'}`);
    const start = plan.startOwner, end = plan.endOwner;
    if (!root.contains(start) || !root.contains(end) || !start.isConnected || !end.isConnected)
      return fail('标题 owner 不属于当前阅读视图');
    if (start === end || start.contains(end) || end.contains(start) || !(start.compareDocumentPosition(end) & 4)) {
      plan.orderPassed = false;return fail('DOM 顺序与源码标题顺序不一致');
    }
    const chapterHeadings = sourceHeadings.filter(h => h.position.start.line >= starts[0].position.start.line &&
      h.position.start.line <= ends[0].position.start.line);
    const headingOwners = new Map(), matchedNodes = [];
    let previousDomIndex = -1;
    for (const heading of chapterHeadings) {
      if (sectionAt(heading).length !== 1) {plan.orderPassed = false;return fail('章节内标题缺少唯一源区块');}
      const match = identify(heading), index = domHeadings.indexOf(match.node);
      if (match.evidence.reason) {plan.orderPassed = false;return fail(`章节内标题：${match.evidence.reason}`);}
      if (index <= previousDomIndex || headingOwners.has(match.owner)) {
        plan.orderPassed = false;return fail('DOM 顺序与源码标题顺序不一致');
      }
      previousDomIndex = index;matchedNodes.push(match.node);
      headingOwners.set(match.owner, match.evidence.sourceRange);
    }
    const firstIndex = domHeadings.indexOf(startMatch.node), lastIndex = domHeadings.indexOf(endMatch.node);
    if (firstIndex < 0 || lastIndex < firstIndex ||
        domHeadings.slice(firstIndex, lastIndex + 1).some(el => !matchedNodes.includes(el))) {
      plan.orderPassed = false;return fail('章节边界内存在无法与源码顺序核对的 DOM 标题');
    }
    plan.orderPassed = true;
    if (start.parentElement !== end.parentElement) return fail('边界 owner 不在同一父容器，无法证明连续章节范围');

    // Title boundaries prove membership; content coverage remains independent.
    // Existing source evidence is used only to reject positive contradictions,
    // never as a prerequisite for an interior Markdown node.
    const members = [];
    let previousEnd = range.startLine - 1;
    for (let node = start; node && node !== end; node = node.nextSibling) {
      if (node.nodeType === 3 && !node.textContent.trim()) continue;
      if (node.nodeType !== 1 && node.nodeType !== 3 && node.nodeType !== 8)
        return fail('章节区间含无法确认边界的节点');
      members.push(node);
      if (node.nodeType !== 1) {
        plan.contentNodesUnchecked.push({nodeType: node.nodeType, domPath: this.hooks.elementPath(node.parentElement, root),
          reason: '仅验证标题边界；内容覆盖未检查'});
        continue;
      }
      const headingRange = headingOwners.get(node);
      const mapped = headingRange ? null : trustedSection(node, this.plugin, this.source, this.file, this.hooks);
      const bounds = headingRange || (mapped && {startLine: mapped.start + 1, endLine: mapped.end + 1});
      if (bounds) {
        if (!contains(range, bounds)) return fail('章节区间含明显跨章节源码容器');
        if (bounds.startLine <= previousEnd) return fail('DOM 顺序与源码顺序不一致');
        previousEnd = bounds.endLine;
      }
      for (const descendant of node.querySelectorAll('*')) {
        const evidence = trustedSection(descendant, this.plugin, this.source, this.file, this.hooks);
        if (evidence && !contains(range, {startLine: evidence.start + 1, endLine: evidence.end + 1}))
          return fail('章节区间含明显跨章节源码容器');
      }
      if (!headingRange) plan.contentNodesUnchecked.push({tagName: node.tagName,
        className: node.getAttribute('class') || '', domPath: this.hooks.elementPath(node, root),
        reason: '仅验证标题边界；unknown、unsupported、映射及 expected blocks 留给 coverage'});
    }
    plan.sectionDomRange = {parentDomPath: this.hooks.elementPath(start.parentElement, root),
      startOwnerDomPath: this.hooks.elementPath(start, root), endOwnerDomPath: this.hooks.elementPath(end, root),
      startInclusive: true, endExclusive: true, memberCount: members.length};
    plan.boundaryEvidence = {basis: 'unique-heading-text-level-dom-order',
      startUnique: true, endUnique: true, textMatched: true, levelMatched: true,
      orderPassed: true, sameParent: true, continuousSiblingRange: true,
      noInterveningChapterHeading: true, contentCoverageChecked: false};
    plan.status = 'ready';return plan;
  }
  liveSectionPlanDiagnostic(target) {
    let plan;
    try { plan = this.sectionPlan(target, this.root); }
    catch { plan = {sourceRange: target.ranges.length === 1 ? {...target.ranges[0]} : null,
      expectedBlocks: target.expected.map(block => ({...block})), startOwner: null, endOwner: null,
      startHeading: null, endHeading: null, orderPassed: null,
      status: 'unavailable', reason: '边界验证异常；未建立可信 sectionPlan'}; }
    const describe = (owner, heading) => {
      if (!owner) return null;
      return {tagName: owner.tagName, className: owner.getAttribute('class') || '',
        domPath: this.hooks.elementPath(owner, this.root), sourceRange: heading?.sourceRange || null,
        mapping: 'metadata-heading-text-level-order'};
    };
    // Serialize boundary evidence without DOM references; do not alter scanning.
    try {return {...plan, startOwner: describe(plan.startOwner, plan.startHeading),
      endOwner: describe(plan.endOwner, plan.endHeading)};}
    catch {return {...plan, startOwner: null, endOwner: null, status: 'unavailable', reason: 'owner 诊断序列化失败'};}
  }
  sectionPlanDiagnostic(target) {
    const after = this.liveSectionPlanDiagnostic(target);
    const snapshots = this.sectionSnapshots.get(target.index) || [];
    // Prefer a complete proof made while the boundary owners were connected.
    // A missing final DOM is not grounds to discard that historical proof.
    const cached = snapshots.find(plan => plan.status === 'ready') ||
      snapshots.find(plan => plan.startHeading?.domFound && plan.endHeading?.domFound) ||
      snapshots.find(plan => plan.startHeading?.domFound || plan.endHeading?.domFound) || snapshots[0];
    const plan = cached || after;
    const heading = (name) => {
      const base = plan[name];
      if (!base) return base;
      return {...base,
        headingDuringScanFound: snapshots.some(item => item[name]?.domFound),
        headingAfterScanFound: !!after[name]?.domFound};
    };
    // Any observed duplicate/text/level/order contradiction invalidates even
    // an earlier ready snapshot. Repeated screens are not duplicate headings.
    const contradiction = [...snapshots, after].find(item =>
      [item.startHeading, item.endHeading].some(h => h &&
        (!h.sourceUnique || h.domMatches > 1 || (h.domFound && !h.levelMatches))) ||
      item.orderPassed === false || /重复|层级不匹配|跨章节|父容器|无法确认边界/.test(item.reason || ''));
    return {...plan, startHeading: heading('startHeading'), endHeading: heading('endHeading'),
      evidenceSource: cached ? 'during-scan' : 'after-scan',
      headingSnapshots: this.headingSnapshots,
      ...(this.headingEvidenceFailed ? {status: 'unavailable', reason: '扫描标题证据记录失败'} : {}),
      ...(contradiction ? {status: 'unavailable', reason: contradiction.reason, orderPassed: contradiction.orderPassed} : {})};
  }
  filter(report, method) {
    const allBlocks = report.blocks;
    const targets = this.targets.map(target => {
      const sectionPlan = target.requested.kind === 'section' ? this.sectionPlanDiagnostic(target) : null;
      const ignoredOutsideSectionGaps = [], checkedInsideSectionGaps = [], coverageGaps = [];
      for (const [key, gap] of this.mappingGaps) {
        const membership = sectionPlan?.status === 'ready' ? key.sectionMembership?.get(target.index) : null;
        if (membership?.has('inside')) {
          const checked = {...gap, sectionRelation: 'inside'};
          Object.defineProperty(checked, 'gapIdentity', {value: key});
          Object.defineProperty(checked, 'node', {value: key.node});
          checkedInsideSectionGaps.push(checked);coverageGaps.push(checked);
        } else if (membership?.has('outside')) {
          ignoredOutsideSectionGaps.push({...gap, sectionRelation: 'outside'});
        } else coverageGaps.push(gap);
      }
      const rendered = sectionPlan?.status === 'ready' ? this.renderedSectionResult(target, coverageGaps) : null;
      const reasons = rendered ? rendered.reasons : this.reasons(target, this.groups, true, coverageGaps);
      if (method === 'visible') {
        const root = this.root;
        for (const section of target.expected) {
          if (section.textCoverage === 'excluded') continue;
          const group = this.groups.get(`${section.startLine - 1}:${section.endLine - 1}`);
          if (!root || !group || [...group.nodes.values(), ...group.headings].some(el => !fullyVisible(el, root))) reasons.push('局部扫描时目标不再完整可见');
        }
      }
      const selected = rendered ? rendered.blocks : allBlocks.filter(block => block.sourceStartLine != null && target.ranges.some(r => intersects(r, {startLine: block.sourceStartLine, endLine: block.sourceEndLine})));
      return {...target, coverage: reasons.length ? 'uncovered' : 'complete', reasons: [...new Set(reasons)],
        mappingGaps: this.gapsFor(target, coverageGaps),
        ...(sectionPlan ? {sectionPlan, ignoredOutsideSectionGaps, checkedInsideSectionGaps,
          mappingPrecision: rendered?.mappingPrecision || (this.gapsFor(target, coverageGaps).length ? 'partial' : 'exact')} : {}),
        renderedBlocks: rendered?.blocks,
        measuredBlocks: selected.length, suspected: selected.filter(b => b.suspected).length};
    });
    const ranges = this.targets.flatMap(target => target.ranges);
    const blocks = targets.some(target => target.renderedBlocks) ? targets.flatMap(target => target.renderedBlocks ||
      allBlocks.filter(block => block.sourceStartLine != null && target.ranges.some(range => intersects(range,
        {startLine: block.sourceStartLine, endLine: block.sourceEndLine})))) : allBlocks.filter(block => block.sourceStartLine != null && ranges.some(r => intersects(r, {startLine: block.sourceStartLine, endLine: block.sourceEndLine})));
    for (const target of targets) delete target.renderedBlocks;
    const skipped = report.skipped.filter(block => block.sourceStartLine == null || ranges.some(r => intersects(r, {startLine: block.sourceStartLine, endLine: block.sourceEndLine})));
    const complete = targets.every(target => target.coverage === 'complete');
    return {...report, schemaVersion: 3, scope: '指定修改目标；按完整源区块筛选，非全文验收', blocks, skipped,
      documentCoverage: report.scan.full ? (report.scan.complete ? 'complete' : 'incomplete') : 'not-scanned',
      targeting: {completionScope: 'targets', scanMethod: method, filterGranularity: 'source-block', coverageBasis: 'target-source-blocks-v1',
        originalBlockCount: allBlocks.length, coverage: complete ? 'complete' : 'uncovered',
        result: complete ? (blocks.some(b => b.suspected) ? 'suspected' : 'clear') : 'uncovered', targets}};
  }
}

async function scanTargets(view, plugin, input, source, hooks) {
  const targets = resolveTargets(input, source, plugin.app.metadataCache.getFileCache(view.file) || {});
  const tracker = new TargetTracker(targets, plugin, source, view.file.path, hooks);
  let local = false;
  if (targets.length === 1 && targets[0].resolved) {
    await hooks.refreshReading(view, plugin);
    const root = view.containerEl.querySelector('.markdown-preview-view');
    if (root.ownerDocument.fonts) await root.ownerDocument.fonts.ready;
    await hooks.settleLayout(root);
    local = await tracker.localize(view);
  }
  const report = await hooks.inspect(view, plugin, !local, (root, result) => tracker.observe(root, result));
  return tracker.filter(report, local ? 'visible' : 'full');
}

module.exports = {resolveTargets, TargetTracker, scanTargets};
