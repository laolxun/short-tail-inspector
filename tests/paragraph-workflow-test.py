"""Strict paragraph acceptance in synthetic mailboxes; never a real Vault."""
from pathlib import Path
import hashlib
import json
import runpy
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent
legacy = runpy.run_path(str(HERE / 'scan-note-test.py'))


class ParagraphWorkflowTests(unittest.TestCase):
    invoke = legacy['CLITests'].invoke

    def setUp(self):
        legacy['CLITests'].setUp(self)
        self.note.write_text('# 章\n\n> 第一段完整正文\n>\n> 第二段完整正文\n', encoding='utf-8')
        self.selection = '第二段完整正文'

    def args(self):
        target = {'kind': 'lines', 'startLine': 3, 'endLine': 5,
                  'text': '\n'.join(self.note.read_bytes().decode().split('\n')[2:5])}
        return ['--target', json.dumps(target, ensure_ascii=False), '--expected-source-sha256',
                hashlib.sha256(self.note.read_bytes()).hexdigest(), '--include-request',
                '--select-paragraph', self.selection]

    def guarded(self, mutate=None, **kwargs):
        def respond(report, reply):
            target = report['targeting']['targets'][0]
            target.update(resolved=True, ranges=[{'startLine': 3, 'endLine': 5}], reasons=[],
                          expected=[{'startLine': 3, 'endLine': 5, 'type': 'blockquote'}], measuredBlocks=2, suspected=1)
            report['scan'] = {'full': False, 'complete': False}
            report['targeting'].update(completionScope='targets', scanMethod='visible',
                                       result='uncovered' if reply['status'] == 'incomplete' else 'suspected')
            report['blocks'] = []
            for i, text in enumerate(['第一段完整正文', '第二段完整正文']):
                path = f'0.{i}'
                report['blocks'].append({'key': f'2:4:{path}', 'domPath': path,
                                        'sourceStartLine': 3, 'sourceEndLine': 5,
                                        'measurementUnit': {'type': 'paragraph', 'text': text,
                                                            'complete': True, 'reasons': []},
                                        'text': text, 'lineCount': 2, 'availableWidthPx': 120,
                                        'protectedContent': False, 'suspected': i == 1})
            reply.update(sourceSha256=report['sourceSha256'], completionScope='targets',
                         scanMethod='visible', blocks=2, suspected=1, targetResult=report['targeting']['result'])
            if mutate:
                mutate(report, reply)
        return self.invoke(self.args(), mutate=respond, **kwargs)

    def test_visible_container_passes_and_selects_only_second_paragraph(self):
        result = self.guarded()
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        a = out['paragraphAcceptance']
        self.assertEqual(a['coverage'], 'covered')
        self.assertEqual(a['containerCoverage'], 'complete')
        self.assertEqual(a['result'], 'suspected')
        self.assertEqual(a['selectedBlock']['key'], '2:4:0.1')
        self.assertEqual(out['response']['blocks'], 2)
        self.assertEqual(out['request'], self.request)
        self.assertTrue(a['rangeMatched'])

    def test_full_container_passes_without_merging_paragraphs(self):
        def change(report, reply):
            report['scan'] = {'full': True, 'complete': True}
            report['targeting']['scanMethod'] = reply['scanMethod'] = 'full'
        result = self.guarded(change)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['paragraphAcceptance']['selectedBlock']['measurementUnit']['text'], self.selection)

    def test_source_container_types_do_not_merge_selected_nodes(self):
        for kind in ['paragraph', 'blockquote', 'list', 'callout']:
            with self.subTest(kind=kind):
                self.setUp()
                result = self.guarded(lambda r, p: r['targeting']['targets'][0]['expected'][0].update(type=kind))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)['paragraphAcceptance']['selectedBlock']['key'], '2:4:0.1')

    def test_first_paragraph_clear_does_not_inherit_container_suspicions(self):
        self.selection = '第一段完整正文'
        result = self.guarded()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['paragraphAcceptance']['result'], 'clear')

    def test_hard_break_identity_preserves_newline(self):
        self.selection = '第二段\n完整正文'
        def change(report, reply):
            report['blocks'][1]['measurementUnit']['text'] = self.selection
            report['blocks'][1]['text'] = '第二段完整正文'
            report['blocks'][1]['manualBreakCount'] = 1
        result = self.guarded(change)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_fragment_similar_text_and_cross_paragraph_paste_rejected(self):
        for text in ['第二段', '第二段完整', '第二段完整正文。', '第一段完整正文\n第二段完整正文']:
            with self.subTest(text=text):
                self.setUp();self.selection = text
                result = self.guarded()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('missing or ambiguous', result.stderr)

    def test_identical_text_in_two_nodes_is_ambiguous(self):
        def change(report, reply):
            report['blocks'][0]['measurementUnit']['text'] = self.selection
        result = self.guarded(change)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ambiguous', result.stderr)

    def test_selected_node_evidence_failures(self):
        mutations = {
            'old-report': lambda b: b.pop('measurementUnit'),
            'whole-list': lambda b: b['measurementUnit'].update(type='list-item-text'),
            'whole-code': lambda b: b['measurementUnit'].update(type='code-block'),
            'hidden-or-clipped': lambda b: b['measurementUnit'].update(complete=False, reasons=['hidden']),
            'unknown': lambda b: b['measurementUnit'].pop('complete'),
            'reason-left': lambda b: b['measurementUnit'].update(reasons=['unknown pseudo']),
            'protected': lambda b: b.update(protectedContent=True),
            'no-geometry': lambda b: b.update(lineCount=0),
            'bad-width': lambda b: b.update(availableWidthPx=0),
            'bad-path': lambda b: b.update(domPath='other'),
            'key-mismatch': lambda b: b.update(key='wrong'),
            'different-container': lambda b: b.update(sourceStartLine=1),
            'wrong-end': lambda b: b.update(sourceEndLine=6),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                self.setUp()
                result = self.guarded(lambda report, reply: mutate(report['blocks'][1]))
                self.assertNotEqual(result.returncode, 0, name)

    def test_duplicate_stable_key_rejected(self):
        result = self.guarded(lambda report, reply: report['blocks'][0].update(
            key=report['blocks'][1]['key'], domPath=report['blocks'][1]['domPath']))
        self.assertNotEqual(result.returncode, 0)

    def test_container_scope_failures(self):
        mutations = [
            lambda r, p: r['targeting']['targets'][0].update(resolved=False),
            lambda r, p: r['targeting']['targets'][0].update(ranges=[{'startLine': 3, 'endLine': 4}]),
            lambda r, p: r['targeting']['targets'][0].update(expected=[{'startLine': 2, 'endLine': 5}]),
            lambda r, p: r['targeting']['targets'][0].update(expected=[]),
            lambda r, p: r['targeting']['targets'][0].update(reasons=['missing body']),
            lambda r, p: r['targeting']['targets'][0].update(measuredBlocks=1),
            lambda r, p: p.update(blocks=1),
            lambda r, p: p.update(suspected=0),
            lambda r, p: r['targeting']['targets'][0].update(suspected=0),
            lambda r, p: (r['targeting'].update(result='clear'), p.update(targetResult='clear')),
            lambda r, p: p.update(sourceSha256='f' * 64),
            lambda r, p: p.update(scanMethod='full'),
            lambda r, p: p.update(completionScope='full'),
            lambda r, p: r.update(scan={'full': True, 'complete': False}),
            lambda r, p: (r['targeting'].update(scanMethod='full'), p.update(scanMethod='full'), r.update(scan={'full': True, 'complete': False})),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp();result = self.guarded(mutate)
                self.assertNotEqual(result.returncode, 0)

    def test_incomplete_container_never_selects_a_paragraph(self):
        result = self.guarded(status='incomplete')
        self.assertEqual(result.returncode, 1)
        a = json.loads(result.stdout)['paragraphAcceptance']
        self.assertEqual(a['coverage'], 'uncovered')
        self.assertIsNone(a['selectedBlock'])

    def test_old_archive_and_target_identity_rejected(self):
        result = self.guarded(wrong_id=True)
        self.assertNotEqual(result.returncode, 0)
        self.setUp()
        result = self.guarded(lambda r, p: r['targeting']['targets'][0].update(
            requested={'kind': 'lines', 'startLine': 1, 'endLine': 5}))
        self.assertNotEqual(result.returncode, 0)

    def test_hash_change_during_scan_rejected(self):
        result = self.guarded(lambda r, p: self.note.write_text(self.note.read_text() + 'changed'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Source changed', result.stderr)

    def test_invalid_strict_arguments_do_not_write_requests(self):
        base = self.args()
        variants = [base[:2] + ['--include-request', '--select-paragraph', self.selection],
                    base[:-1] + [''], base + ['--lines', '1:1']]
        target = {'kind': 'lines', 'startLine': 3, 'endLine': 5, 'text': '片段'}
        variants.append(['--target', json.dumps(target), *base[2:]])
        target.pop('text');variants.append(['--target', json.dumps(target), *base[2:]])
        variants.append([*base[:3], 'f' * 64, *base[4:]])
        for args in variants:
            result = subprocess.run([sys.executable, '-B', str(HERE.parent / 'scan-note.py'),
                                     'synthetic.md', '--vault', str(self.root), *args], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.plugin / 'request.json').exists())


if __name__ == '__main__':
    unittest.main()
