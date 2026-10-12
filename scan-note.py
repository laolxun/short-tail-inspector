#!/usr/bin/env python3
"""Ask the installed plugin to scan an already open note; no screenshots."""
from pathlib import Path
import argparse
import hashlib
import json
import math
import os
import re
import time
import uuid


def publish_request(plugin, request):
    """Atomically submit via a dedicated, same-filesystem writable directory."""
    staging = plugin / 'requests'
    if staging.is_symlink():
        raise SystemExit('Request staging directory must not be a symbolic link')
    staging.mkdir(exist_ok=True)
    if not staging.is_dir() or staging.resolve().parent != plugin.resolve():
        raise SystemExit('Request staging directory is outside the plugin')
    if staging.stat().st_dev != plugin.stat().st_dev:
        raise SystemExit('Request staging directory must use the plugin filesystem')
    tmp = staging / ('request-' + request['id'] + '.tmp')
    try:
        with tmp.open('x', encoding='utf-8') as stream:
            stream.write(json.dumps(request, ensure_ascii=False))
        try:
            os.replace(tmp, plugin / 'request.json')
        finally:
            if tmp.exists():
                tmp.unlink()
    except OSError as error:
        raise SystemExit('Cannot submit scan request: ' + str(error))


def parse_targets(args, parser, line_count):
    targets = []
    for value in args.target:
        try:
            target = json.loads(value)
        except json.JSONDecodeError:
            parser.error('--target must be a JSON object')
        if not isinstance(target, dict):
            parser.error('--target must be a JSON object')
        targets.append(target)
    for value in args.lines:
        try:
            start, end = (int(part) for part in value.split(':'))
        except ValueError:
            parser.error('--lines must be START:END (1-based, inclusive)')
        targets.append({'kind': 'lines', 'startLine': start, 'endLine': end})
    targets.extend({'kind': 'paragraph', 'text': text} for text in args.paragraph)
    if len(targets) > 100:
        parser.error('At most 100 targets are allowed')
    for target in targets:
        if target.get('kind') not in ('paragraph', 'lines'):
            parser.error('Target kind must be paragraph or lines')
        if 'headingPath' in target:
            parser.error('headingPath targets are not supported; use exact source lines or paragraph text')
        if 'startLine' in target or 'endLine' in target:
            start, end = target.get('startLine'), target.get('endLine')
            if type(start) is not int or type(end) is not int or not 1 <= start <= end <= line_count:
                parser.error('Target lines must be a valid 1-based inclusive source range')
        elif not (target.get('kind') == 'paragraph' and target.get('text')):
            parser.error('Target requires source lines or paragraph text')
        if 'text' in target and (not isinstance(target['text'], str) or not target['text'].strip()):
            parser.error('Paragraph text must be a nonempty source string')
    return targets


def verify_report(response, request, root, plugin):
    if response.get('id') != request['id']:
        raise SystemExit('Response identity mismatch: id')
    relative = response.get('archivePath')
    if not isinstance(relative, str):
        raise SystemExit('Response has no archivePath')
    archive = root / relative
    history_path = plugin / 'reports'
    history = history_path.resolve()
    if history_path.is_symlink() or not history.is_relative_to(plugin.resolve()) or archive.is_symlink() or archive.parent.resolve() != history or not archive.is_file():
        raise SystemExit('Response archivePath is not a regular plugin history file')
    try:
        report = json.loads(archive.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit('Cannot validate this response archive: ' + str(error))
    for key, value in [('requestId', request['id']), ('file', request['file']),
                       ('sourceSha256', request['expectedSourceSha256'])]:
        if report.get(key) != value:
            raise SystemExit('Response archive identity mismatch: ' + key)
    if request['schemaVersion'] == 2:
        targeting = report.get('targeting', {})
        if response.get('schemaVersion') != 2 or report.get('schemaVersion') != 3 or not isinstance(targeting, dict):
            raise SystemExit('Plugin did not return the targeted-scan protocol')
        if response.get('sourceSha256') != request['expectedSourceSha256']:
            raise SystemExit('Response identity mismatch: sourceSha256')
        if response.get('completionScope') != 'targets' or targeting.get('completionScope') != 'targets':
            raise SystemExit('Target completionScope mismatch')
        method = response.get('scanMethod')
        scan = report.get('scan', {})
        if (method not in ('visible', 'full') or targeting.get('scanMethod') != method or
                scan.get('full') is not (method == 'full')):
            raise SystemExit('Target scanMethod mismatch')
        targets = targeting.get('targets')
        if (not isinstance(targets, list) or any(not isinstance(t, dict) for t in targets) or
                json.dumps([t.get('requested') for t in targets], sort_keys=True) != json.dumps(request['targets'], sort_keys=True) or
                json.dumps(response.get('targets'), sort_keys=True) != json.dumps(targets, sort_keys=True)):
            raise SystemExit('Target identity mismatch between request, response and archive')
        for target in targets:
            requested = target.get('requested') or {}
            if (requested.get('kind') == 'lines' and target.get('resolved') is True and
                    json.dumps(target.get('ranges'), sort_keys=True) != json.dumps(
                        [{key: requested[key] for key in ('startLine', 'endLine')}], sort_keys=True)):
                raise SystemExit('Target range differs from the requested source lines')
        if response.get('status') == 'complete' and (response.get('targetCoverage') != 'complete' or
                targeting.get('coverage') != 'complete' or targeting.get('result') not in ('clear', 'suspected') or
                any(t.get('coverage') != 'complete' or t.get('resolved') is not True for t in targets)):
            raise SystemExit('Target coverage is incomplete; complete/clear is not valid')
        if (response.get('status') == 'complete' and method == 'full' and scan.get('complete') is not True and
                targeting.get('coverageBasis') != 'target-source-blocks-v1'):
            raise SystemExit('Full scan is incomplete without scoped target coverage evidence')
        if (targeting.get('result') not in ('clear', 'suspected', 'uncovered') or
                response.get('targetResult') != targeting.get('result')):
            raise SystemExit('Target result mismatch between response and archive')
        if (response.get('targetCoverage') != targeting.get('coverage') or
                response.get('status') == 'incomplete' and (targeting.get('coverage') != 'uncovered' or
                targeting.get('result') != 'uncovered' or not any(t.get('coverage') == 'uncovered' for t in targets))):
            raise SystemExit('Target coverage/status mismatch between response and archive')
        if targeting.get('coverageBasis') is not None:
            if targeting['coverageBasis'] != 'target-source-blocks-v1':
                raise SystemExit('Unknown target coverage basis')
            scan = report.get('scan', {})
            document_coverage = ('complete' if scan.get('complete') is True else 'incomplete') if scan.get('full') is True else 'not-scanned'
            if report.get('documentCoverage') != document_coverage or response.get('documentCoverage') != document_coverage:
                raise SystemExit('Document coverage mismatch between response and archive')
            for target in targets:
                mappings_valid = not target.get('mappingGaps')
                if target.get('coverage') == 'complete' and (
                        target.get('resolved') is not True or not isinstance(target.get('ranges'), list) or len(target['ranges']) != 1 or
                        not isinstance(target.get('expected'), list) or not target['expected'] or
                        target.get('reasons') != [] or not mappings_valid or
                        type(target.get('measuredBlocks')) is not int or target['measuredBlocks'] <= 0):
                    raise SystemExit('Target source-block coverage evidence is incomplete')
    return report


def target_range_matches(report, expected):
    targets = report.get('targeting', {}).get('targets', []) if report else []
    return (len(targets) == 1 and targets[0].get('resolved') is True and
            json.dumps(targets[0].get('ranges'), sort_keys=True) == json.dumps([expected], sort_keys=True))


def verify_target_report(response, request, report, expected, label='Target'):
    """Bind the plugin's resolved exact source range to the request."""
    targeting = report['targeting']
    if response.get('sourceSha256') != request['expectedSourceSha256']:
        raise SystemExit('Response identity mismatch: sourceSha256')
    if response.get('completionScope') != 'targets' or targeting.get('completionScope') != 'targets':
        raise SystemExit(label + ' completionScope mismatch')
    method = response.get('scanMethod')
    scan = report.get('scan', {})
    if (method not in ('visible', 'full') or targeting.get('scanMethod') != method or
            scan.get('full') is not (method == 'full')):
        raise SystemExit(label + ' scanMethod mismatch')
    if response['status'] == 'complete':
        if not target_range_matches(report, expected):
            raise SystemExit(label + ' range is unresolved or differs from the requested source range')
        if (method == 'full' and scan.get('complete') is not True and
                targeting.get('coverageBasis') != 'target-source-blocks-v1'):
            raise SystemExit(label + ' full fallback is incomplete')


def verify_paragraph_report(response, request, report, text):
    """Select one complete P node only after its entire source container passes."""
    requested = request['targets'][0]
    expected = {key: requested[key] for key in ('startLine', 'endLine')}
    verify_target_report(response, request, report, expected, 'Paragraph container')
    acceptance = {'coverage': 'uncovered', 'containerCoverage': response['targetCoverage'],
                  'requestedText': text, 'rangeMatched': target_range_matches(report, expected),
                  'selectedBlock': None}
    if response['status'] != 'complete':
        return acceptance
    target = report['targeting']['targets'][0]
    if target.get('reasons') != []:
        raise SystemExit('Paragraph container still has coverage blockers')
    sections = target.get('expected')
    if not isinstance(sections, list) or not sections:
        raise SystemExit('Paragraph container has no source-block evidence')
    for section in sections:
        if (not isinstance(section, dict) or any(type(section.get(k)) is not int for k in expected) or
                not expected['startLine'] <= section['startLine'] <= section['endLine'] <= expected['endLine']):
            raise SystemExit('Paragraph container cuts a source block or has invalid bounds')
    blocks = report.get('blocks')
    if not isinstance(blocks, list) or any(not isinstance(b, dict) for b in blocks):
        raise SystemExit('Paragraph measurement blocks missing')
    if (type(response.get('blocks')) is not int or response['blocks'] != len(blocks) or
            type(target.get('measuredBlocks')) is not int or target['measuredBlocks'] != len(blocks)):
        raise SystemExit('Paragraph measurement block count mismatch')
    suspected = sum(b.get('suspected') is True for b in blocks)
    if (any(type(b.get('suspected')) is not bool for b in blocks) or
            type(response.get('suspected')) is not int or response['suspected'] != suspected or
            type(target.get('suspected')) is not int or target['suspected'] != suspected or
            report['targeting']['result'] != ('suspected' if suspected else 'clear')):
        raise SystemExit('Paragraph container result/count mismatch')
    for block in blocks:
        start, end, path = block.get('sourceStartLine'), block.get('sourceEndLine'), block.get('domPath')
        if (type(start) is not int or type(end) is not int or not isinstance(path, str) or
                re.fullmatch(r'(?:[0-9]+(?:\.[0-9]+)*)?', path) is None or
                not expected['startLine'] <= start <= end <= expected['endLine'] or
                not any(s['startLine'] == start and s['endLine'] == end for s in sections) or
                block.get('key') != f'{start - 1}:{end - 1}:{path}'):
            raise SystemExit('Paragraph block identity/range is not bound to the container')
    matches = [b for b in blocks if isinstance(b.get('measurementUnit'), dict) and
               b['measurementUnit'].get('type') == 'paragraph' and b['measurementUnit'].get('text') == text]
    if len(matches) != 1:
        raise SystemExit('Complete paragraph text is missing or ambiguous; fragments are only location clues')
    block = matches[0]
    unit = block['measurementUnit']
    if (unit.get('complete') is not True or unit.get('reasons') != [] or
            block.get('protectedContent') is not False or type(block.get('lineCount')) is not int or
            block['lineCount'] < 1 or type(block.get('suspected')) is not bool or
            type(block.get('availableWidthPx')) not in (int, float) or not math.isfinite(block['availableWidthPx']) or block['availableWidthPx'] <= 0 or
            sum(b.get('key') == block['key'] for b in blocks) != 1):
        raise SystemExit('Selected paragraph lacks complete unique measurement evidence')
    acceptance.update(coverage='covered', selectedBlock=block,
                      result='suspected' if block['suspected'] else 'clear')
    return acceptance


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('note', help='Vault-relative note path')
    parser.add_argument('--vault', required=True, help='Path to the target vault root')
    parser.add_argument('--width', type=float, default=700)
    parser.add_argument('--font-size', type=float, default=16)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--target', action='append', default=[], help='Target JSON object; repeat for multiple changes')
    parser.add_argument('--lines', action='append', default=[], help='1-based inclusive START:END; repeat for multiple changes')
    parser.add_argument('--paragraph', action='append', default=[], help='Exact paragraph source text')
    parser.add_argument('--expected-source-sha256', help='Require the exact source version used to locate targets')
    parser.add_argument('--include-request', action='store_true', help='Output original request and response in an envelope')
    parser.add_argument('--select-paragraph', help='Exact complete rendered paragraph text, not a location fragment; strict container acceptance')
    args = parser.parse_args()
    if any(not math.isfinite(value) or value <= 0 for value in (args.timeout, args.width, args.font_size)):
        parser.error('Timeout, width and font size must be positive')
    root = Path(args.vault).resolve()
    note = (root / args.note).resolve()
    if not note.is_relative_to(root) or not note.is_file():
        parser.error('Note must exist inside the vault')
    source = note.read_bytes()
    targets = parse_targets(args, parser, len(source.decode('utf-8').split('\n')))
    source_hash = hashlib.sha256(source).hexdigest()
    if args.expected_source_sha256 is not None:
        if len(args.expected_source_sha256) != 64 or any(c not in '0123456789abcdef' for c in args.expected_source_sha256):
            parser.error('Expected source hash must be a lowercase SHA-256')
        if source_hash != args.expected_source_sha256:
            parser.error('Source changed since target location; reread and resolve the target')
    if args.select_paragraph is not None:
        if (not args.select_paragraph.strip() or not args.expected_source_sha256 or not args.include_request or
                len(targets) != 1 or
                targets[0].get('kind') != 'lines' or set(targets[0]) != {'kind', 'startLine', 'endLine', 'text'}):
            parser.error('Paragraph selection requires a source hash, include-request and one lines target with exact source text')
        target = targets[0]
        if '\n'.join(source.decode('utf-8').split('\n')[target['startLine'] - 1:target['endLine']]) != target['text']:
            parser.error('Paragraph container text differs from the source range')
    plugin = root / '.obsidian/plugins/short-tail-inspector'
    if not (plugin / 'main.js').is_file():
        parser.error('Plugin is not installed')
    request = {'schemaVersion': 2 if targets else 1, 'id': uuid.uuid4().hex, 'action': 'scan',
               'file': note.relative_to(root).as_posix(), 'expectedSourceSha256': source_hash,
               'expectedLayout': {'contentWidthPx': args.width, 'fontSizePx': args.font_size},
               'temporaryReadingLayout': True, 'expiresAt': int((time.time() + args.timeout) * 1000)}
    if targets:
        request['targets'] = targets
    # This is a single-request mailbox. Calling clients must serialize requests.
    publish_request(plugin, request)
    end = time.monotonic() + args.timeout
    while time.monotonic() < end:
        try:
            response = json.loads((plugin / 'response.json').read_text(encoding='utf-8'))
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(.3)
            continue
        if response.get('id') == request['id']:
            report = None
            paragraph_acceptance = {'coverage': 'uncovered', 'selectedBlock': None}
            if response.get('status') in ('complete', 'incomplete'):
                report = verify_report(response, request, root, plugin)
                if args.select_paragraph is not None:
                    paragraph_acceptance = verify_paragraph_report(response, request, report, args.select_paragraph)
            if args.expected_source_sha256 is not None and hashlib.sha256(note.read_bytes()).hexdigest() != source_hash:
                raise SystemExit('Source changed before response acceptance; reread and resolve the target')
            output = {'request': request, 'response': response} if args.include_request else response
            if args.select_paragraph is not None:
                output['paragraphAcceptance'] = paragraph_acceptance
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 0 if response.get('status') == 'complete' else 1
        time.sleep(.3)
    raise SystemExit('No response before timeout; verify that Obsidian and the plugin are running')


if __name__ == '__main__':
    raise SystemExit(main())
