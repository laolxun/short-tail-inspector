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
  return input.map((target, index) => {
    if (!target || !['paragraph', 'lines'].includes(target.kind)) throw new Error('目标 kind 必须是 paragraph 或 lines；不支持章节目标');
    if (target.headingPath !== undefined) throw new Error('不支持 headingPath；请使用精确源码行或段落目标');
    if (target.text !== undefined && (typeof target.text !== 'string' || !target.text.trim())) throw new Error('段落 text 必须是非空源码文本');
    const explicit = target.startLine !== undefined || target.endLine !== undefined;
    let ranges = [], reason = null;
    if (explicit) {
      if (!Number.isInteger(target.startLine) || !Number.isInteger(target.endLine) ||
          target.startLine < 1 || target.endLine < target.startLine || target.endLine > lines.length) throw new Error('目标源码行必须是有效的 1-based 闭区间');
      ranges = [{startLine: target.startLine, endLine: target.endLine}];
    } else if (target.kind === 'paragraph' && target.text) {
      ranges = sections.filter(s => s.type === 'paragraph' &&
        lines.slice(s.position.start.line, s.position.end.line + 1).join('\n') === target.text).map(sectionRange);
      if (ranges.length !== 1) reason = '段落缺失或源码文本不唯一';
    } else throw new Error('目标需要 startLine/endLine，或段落 text');
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
  const include = el => {
    if(!hooks.includeNode || hooks.includeNode(el))return true;
    // A captured source container still owes all its nodes, including siblings
    // outside the viewport. Never turn a partial container into full coverage.
    const sec=trustedSection(el,plugin,source,file,hooks);
    return sec && wantedRanges.some(r=>intersects(r,{startLine:sec.start+1,endLine:sec.end+1}));
  };
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
    if(!include(el))continue;
    if (el.closest('table,.frontmatter,.metadata-container,.markdown-embed') ||
        (el.tagName === 'P' && el.closest('pre')) || (el.tagName === 'LI' && el.querySelector(':scope > p'))) continue;
    const found = get(el);
    // Unmapped text could belong to a target; it cannot be silently excluded.
    if (!found) {if ((found === null || hooks.includeNode?.(el) && !/^H[1-6]$/.test(el.tagName)) && el.textContent.trim()) unknown(el, 'text');continue;}
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
    if(!include(el))continue;
    if (el.closest('.frontmatter,.metadata-container,.callout-icon,.callout-fold,.collapse-indicator,.heading-collapse-indicator,button,.copy-code-button,.sr-only')) continue;
    const found = get(el);
    if (found) found.group.unsupported.push(el);
    else if (found === null || hooks.includeNode?.(el)) unknown(el, 'unsupported');
  }
  for (const el of root.querySelectorAll('.callout')) {
    if(!include(el))continue;
    if (el.closest('.markdown-embed')) continue;
    const found = get(el);
    if (found) {
      found.group.callouts.add(el);
      const section = (cache.sections || []).filter(s => sectionRange(s).startLine === found.sec.start + 1 && sectionRange(s).endLine === found.sec.end + 1);
      if (section.length !== 1 || !['callout', 'list'].includes(section[0].type)) found.group.calloutIssues.push('Callout 子范围缺少可信区块 metadata');
      else if (section[0].type === 'callout') found.group.calloutIssues.push(...calloutIssues(el, found.sec, source));
    } else if (found === null || hooks.includeNode?.(el)) unknown(el, 'unsupported');
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
    if(!include(el))continue;
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
  }
  observe(root, result) {
    this.root = root;
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
    return gaps.filter(gap => !gap.possibleRange || target.ranges.some(r => intersects(r, gap.possibleRange)));
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
  filter(report, method, strict = false) {
    const allBlocks = report.blocks;
    const targets = this.targets.map(target => {
      const coverageGaps = this.gapsFor(target);
      const reasons = this.reasons(target, this.groups, true, coverageGaps);
      if (method === 'visible') {
        const root = this.root;
        for (const section of target.expected) {
          if (section.textCoverage === 'excluded') continue;
          const group = this.groups.get(`${section.startLine - 1}:${section.endLine - 1}`);
          if (!root || !group || [...group.nodes.values(), ...group.headings].some(el => !fullyVisible(el, root))) reasons.push('局部扫描时目标不再完整可见');
        }
      }
      const selected = allBlocks.filter(block => block.sourceStartLine != null &&
        target.ranges.some(r => intersects(r, {startLine: block.sourceStartLine, endLine: block.sourceEndLine})));
      if(strict && selected.some(b=>b.measurementUnit?.type==='paragraph' && (b.measurementUnit.complete!==true || b.measurementUnit.reasons?.length!==0)))reasons.push('目标段落含未完整测量的字符');
      return {...target, coverage: reasons.length ? 'uncovered' : 'complete', reasons: [...new Set(reasons)],
        mappingGaps: coverageGaps, measuredBlocks: selected.length, suspected: selected.filter(b => b.suspected).length};
    });
    const ranges = this.targets.flatMap(target => target.ranges);
    const blocks = allBlocks.filter(block => block.sourceStartLine != null &&
      ranges.some(r => intersects(r, {startLine: block.sourceStartLine, endLine: block.sourceEndLine})));
    const skipped = report.skipped.filter(block => block.sourceStartLine == null ||
      ranges.some(r => intersects(r, {startLine: block.sourceStartLine, endLine: block.sourceEndLine})));
    const complete = targets.every(target => target.coverage === 'complete');
    return {...report, schemaVersion: 3, scope: '指定源码行或段落；按完整源区块筛选，非全文验收', blocks, skipped,
      documentCoverage: report.scan.full ? (report.scan.complete ? 'complete' : 'incomplete') : 'not-scanned',
      targeting: {completionScope: 'targets', scanMethod: method, filterGranularity: 'source-block', coverageBasis: 'target-source-blocks-v1',
        originalBlockCount: allBlocks.length, coverage: complete ? 'complete' : 'uncovered',
        result: complete ? (blocks.some(b => b.suspected) ? 'suspected' : 'clear') : 'uncovered', targets}};
  }
}

async function scanTargets(view, plugin, input, source, hooks, options = {}) {
  if(options.localOnly && view.previewMode.get()!==source)throw new Error('阅读视图尚未同步最新文件');
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
  const report = await hooks.inspect(view, plugin, options.localOnly ? false : !local, (root, result) => tracker.observe(root, result));
  return tracker.filter(report, local || options.localOnly ? 'visible' : 'full', options.localOnly===true);
}

// One measurement pass at the settled viewport. Coverage is limited to captured
// source containers; boundary clipping and unknown visible content fail closed.
async function scanVisible(view, plugin, source, hooks) {
  if(view.previewMode.get()!==source)throw new Error('阅读视图尚未同步最新文件');
  let tracker,unmeasuredVisibleText=false;
  const excludedKeys=new Set(),excludedNodes=new Set();
  const report=await hooks.inspect(view,plugin,false,(root,result)=>{
    const bounds=viewportFor(root);
    // Bind exclusions to collect()'s existing source and DOM identities. Unknown
    // PRE text is not exempt merely because it resembles protected code.
    for(const skipped of result.skipped){
      if(skipped.kind!=='代码块' || skipped.sourceMapping?.status!=='mapped' ||
          !Number.isInteger(skipped.sourceStartLine) || !Number.isInteger(skipped.sourceEndLine) ||
          skipped.key!==`${skipped.sourceStartLine-1}:${skipped.sourceEndLine-1}:${skipped.domPath}`)continue;
      const nodes=[...root.querySelectorAll('pre')].filter(el=>hooks.elementPath(el,root)===skipped.renderDomPath);
      if(nodes.length===1){excludedKeys.add(skipped.key);excludedNodes.add(nodes[0]);}
    }
    const inExcludedCode=el=>[...excludedNodes].some(pre=>pre===el || pre.contains(el));
    const includeNode=el=>{if(inExcludedCode(el))return false;const r=el.getBoundingClientRect();return r.width>0 && r.height>0 && r.bottom>bounds.top && r.top<bounds.bottom && r.right>bounds.left && r.left<bounds.right;};
    // Also account for visible text outside the collector's supported selectors.
    const walker=root.ownerDocument.createTreeWalker(root,4);let text;
    while((text=walker.nextNode())){
      if(!text.nodeValue.trim() || inExcludedCode(text.parentElement) || text.parentElement.closest('h1,h2,h3,h4,h5,h6,.frontmatter,.metadata-container,button,.copy-code-button,.sr-only'))continue;
      const range=root.ownerDocument.createRange();range.selectNodeContents(text);
      const onScreen=Array.from(range.getClientRects()).some(r=>r.width>0 && r.height>0 && r.bottom>bounds.top && r.top<bounds.bottom && r.right>bounds.left && r.left<bounds.right);
      if(onScreen && !result.blocks.some(b=>b.renderNode?.contains(text)))unmeasuredVisibleText=true;
    }
    const inputs=[...new Map([...result.blocks,...result.skipped.filter(b=>!excludedKeys.has(b.key))].filter(b=>Number.isInteger(b.sourceStartLine)&&Number.isInteger(b.sourceEndLine))
      .map(b=>[`${b.sourceStartLine}:${b.sourceEndLine}`,{kind:'lines',startLine:b.sourceStartLine,endLine:b.sourceEndLine,text:source.split('\n').slice(b.sourceStartLine-1,b.sourceEndLine).join('\n')}])).values()];
    // resolveTargets' request limit does not limit the number of visible blocks.
    const targets=inputs.map((input,index)=>({...resolveTargets([input],source,plugin.app.metadataCache.getFileCache(view.file)||{})[0],index}));
    tracker=new TargetTracker(targets,plugin,source,view.file.path,{...hooks,includeNode});
    tracker.observe(root,result);
  });
  if(!tracker || report.scan.full || report.scan.steps!==1)throw new Error('视口扫描次数或模式异常');
  const scoped=tracker.filter(report,'visible');
  const reasons=[];
  if(unmeasuredVisibleText)reasons.push('视口存在未纳入测量的文本');
  if(!scoped.targeting.targets.length && !excludedKeys.size)reasons.push('当前视口没有可核对的完整测量目标');
  if([...tracker.mappingGaps.values()].length)reasons.push('可见内容存在未知或未支持的源码映射');
  if(report.scan.missingSourceLocations)reasons.push('测量块缺少源码位置');
  if(report.blocks.some(b=>b.measurementUnit?.type==='paragraph' && (b.measurementUnit.complete!==true || b.measurementUnit.reasons?.length!==0)))reasons.push('段落测量完整性无法确认');
  const skipped=report.skipped.map(item=>({...item,coverage:excludedKeys.has(item.key)?'excluded':'uncovered'}));
  if(skipped.some(item=>item.coverage==='uncovered' && item.kind==='表格'))reasons.push('视口存在未覆盖的表格（未支持测量）');
  if(skipped.some(item=>item.coverage==='uncovered' && item.kind!=='表格'))reasons.push('当前视口存在未完整测量或映射不可信的内容');
  if(scoped.targeting.coverage!=='complete')reasons.push('捕捉的源区块覆盖不完整');
  const capturedTargets=scoped.targeting.targets;
  const blocks=report.blocks.map(block=>{
    const matches=capturedTargets.filter(t=>t.ranges.some(r=>r.startLine===block.sourceStartLine&&r.endLine===block.sourceEndLine));
    const measured=matches.length===1 && matches[0].coverage==='complete' && block.sourceMapping?.status==='mapped' &&
      block.measurementUnit?.type==='paragraph' && block.measurementUnit.complete===true && block.measurementUnit.reasons?.length===0 && !block.protectedContent;
    // collect() already located this node through sourceMappingFor(). A complete
    // P measurement proves geometry, not that its source owner is one standalone
    // Markdown paragraph. Check that existing identity; never search/re-map text.
    const editReasons=[];
    if(!measured)editReasons.push('缺少完整段落测量或可信源码覆盖');
    const expected=matches.length===1?matches[0].expected:[];
    if(expected.length!==1 || expected[0].type!=='paragraph' ||
        expected[0].startLine!==block.sourceStartLine || expected[0].endLine!==block.sourceEndLine)
      editReasons.push('源码范围不是唯一且完整的 paragraph 区块');
    const node=block.renderNode;
    if(node?.tagName!=='P' || !tracker.root.contains(node) ||
        node.closest('blockquote,.callout,.callout-content,.callout-title,li,ul,ol'))
      editReasons.push('渲染节点不是独立正文段落');
    if(report.blocks.filter(other=>Number.isInteger(other.sourceStartLine) &&
        intersects({startLine:block.sourceStartLine,endLine:block.sourceEndLine},
          {startLine:other.sourceStartLine,endLine:other.sourceEndLine})).length!==1)
      editReasons.push('源码范围关联多个测量节点');
    if(block.suspected!==true)editReasons.push('未标为疑似短尾');
    // Display evidence is local to this independently mapped paragraph. Unknown
    // siblings outside its source owner cannot erase its completed measurement.
    // Keep the existing editReasons/eligibleForEdit gate unchanged.
    const group=tracker.groups.get(`${block.sourceStartLine-1}:${block.sourceEndLine-1}`);
    const ownGaps=[...tracker.mappingGaps].filter(([key])=>
      group && [...group.owners].some(owner=>owner.contains(key.node) || key.node.contains(owner))).map(([,gap])=>gap);
    const locallyMeasured=block.sourceMapping?.status==='mapped' && block.measurementUnit?.type==='paragraph' && block.measurementUnit.complete===true &&
      group?.nodes.size===1 && group.owners.size===1 &&
      block.measurementUnit.reasons?.length===0 && !block.protectedContent && expected.length===1 &&
      expected[0].type==='paragraph' && expected[0].startLine===block.sourceStartLine && expected[0].endLine===block.sourceEndLine &&
      node?.tagName==='P' && !node.closest('blockquote,.callout,.callout-content,.callout-title,li,ul,ol') &&
      fullyVisible(node,tracker.root) && tracker.reasons(matches[0],tracker.groups,true,ownGaps).length===0;
    return {...block,capture:{coverage:measured || locallyMeasured?'complete':'uncovered',eligibleForEdit:editReasons.length===0,editReasons}};
  });
  return {...report,schemaVersion:4,scanMode:'visible',documentCoverage:'not-scanned',completionScope:'viewport',
    visibleCoverage:reasons.length?'uncovered':'complete',visibleReasons:reasons,capturedTargets,blocks,skipped};
}

module.exports = {resolveTargets, TargetTracker, scanTargets, scanVisible};
