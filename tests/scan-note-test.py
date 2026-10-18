"""CLI integration using an isolated synthetic mailbox, never a user's Vault."""
from pathlib import Path
import json
import importlib.util
from unittest.mock import patch
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scan-note.py'


class CLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sti-cli-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.note = self.root / 'synthetic.md'
        self.note.write_text('标题\n\n合成段落\n结束\n', encoding='utf-8')
        self.plugin = self.root / '.obsidian/plugins/short-tail-inspector'
        self.plugin.mkdir(parents=True)
        (self.plugin / 'main.js').write_text('// synthetic installation marker', encoding='utf-8')
        self.request = None

    def invoke(self, extra=(), status='complete', wrong_id=False, bad_coverage=False, mutate=None):
        worker_errors = []
        def respond():
            try:
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and not (self.plugin / 'request.json').exists():
                    time.sleep(.01)
                if not (self.plugin / 'request.json').exists():
                    return
                self.request = json.loads((self.plugin / 'request.json').read_text())
                request = self.request
                history = self.plugin / 'reports'
                history.mkdir()
                archive = history / 'synthetic.json'
                relative = archive.relative_to(self.root).as_posix()
                report = {'requestId': 'wrong' if wrong_id else request['id'], 'file': request['file'],
                          'sourceSha256': request['expectedSourceSha256']}
                response = {'id': request['id'], 'status': status, 'archivePath': relative}
                if request['schemaVersion'] == 2 or request.get('scanMode') == 'targets':
                    coverage = 'uncovered' if bad_coverage or status == 'incomplete' else 'complete'
                    targets = [{'requested': target, 'coverage': coverage, 'resolved': True,
                                'ranges': [{'startLine': target['startLine'], 'endLine': target['endLine']}]
                                if target.get('kind') == 'lines' else []} for target in request['targets']]
                    report['schemaVersion'] = 3
                    report['scan'] = {'full': True, 'complete': True}
                    report['documentCoverage'] = 'complete'
                    report['targeting'] = {'targets': targets, 'coverage': coverage,
                                           'result': 'uncovered' if coverage == 'uncovered' else 'clear',
                                           'completionScope': 'targets', 'scanMethod': 'full'}
                    response.update(schemaVersion=2, targetCoverage=coverage,
                                    targetResult=report['targeting']['result'], targets=targets,
                                    sourceSha256=request['expectedSourceSha256'], completionScope='targets',
                                    scanMethod='full', documentCoverage='complete')
                if request['schemaVersion'] == 3:
                    report.update(archivePath=relative, schemaVersion=4, scanMode=request['scanMode'], localOnly=request['localOnly'],
                                  documentCoverage='not-scanned', scan={'full': False, 'complete': False, 'steps': 1, 'missingSourceLocations': False},
                                  layout={'contentWidthPx': 637, 'fontSizePx': 17, 'sidebarsClosed': True})
                    response.update(schemaVersion=3, file=request['file'], sourceSha256=request['expectedSourceSha256'],
                                    scanMode=request['scanMode'], localOnly=request['localOnly'], scanMethod='visible', documentCoverage='not-scanned')
                    if request['scanMode'] == 'visible':
                        coverage = 'uncovered' if bad_coverage or status == 'incomplete' else 'complete'
                        report.update(completionScope='viewport', visibleCoverage=coverage, visibleReasons=[] if coverage == 'complete' else ['missing'],
                                      blocks=[{'key': '2:2:0', 'sourceStartLine': 3, 'sourceEndLine': 3, 'domPath': '0', 'suspected': True,
                                               'sourceMapping': {'status': 'mapped'}, 'measurementUnit': {'type': 'paragraph', 'text': '合成段落', 'complete': True, 'reasons': []},
                                               'protectedContent': False, 'lineCount': 2, 'availableWidthPx': 637,
                                               'capture': {'coverage': 'complete', 'eligibleForEdit': coverage == 'complete', 'editReasons': [] if coverage == 'complete' else ['missing']}}], skipped=[],
                                      capturedTargets=[{'requested': {'kind': 'lines', 'startLine': 3, 'endLine': 3, 'text': '合成段落'}, 'coverage': coverage, 'resolved': True, 'reasons': [], 'mappingGaps': [],
                                                        'ranges': [{'startLine': 3, 'endLine': 3}], 'expected': [{'type': 'paragraph', 'startLine': 3, 'endLine': 3}], 'measuredBlocks': 1}])
                        response.update(completionScope='viewport', visibleCoverage=coverage, blocks=1, suspected=1, skipped=0)
                    else:
                        report['blocks'] = [dict(sourceStartLine=t['startLine'], sourceEndLine=t['endLine'], suspected=False,
                                                 sourceMapping={'status': 'mapped'}, measurementUnit={'type': 'paragraph', 'complete': True, 'reasons': []}) for t in request['targets']]
                        report['skipped'] = []
                        response.update(blocks=len(report['blocks']), suspected=0, skipped=0)
                        report['targeting'].update(scanMethod='visible', coverageBasis='target-source-blocks-v1')
                        for target in report['targeting']['targets']:
                            target.update(expected=[dict(target['ranges'][0], type='paragraph')], reasons=[], mappingGaps=[], measuredBlocks=1)
                if mutate:
                    mutate(report, response)
                archive.write_text(json.dumps(report), encoding='utf-8')
                (self.plugin / 'response.json').write_text(json.dumps(response), encoding='utf-8')
            except Exception as error:
                worker_errors.append(error)
        worker = threading.Thread(target=respond)
        worker.start()
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'synthetic.md', '--vault', str(self.root),
                                 '--timeout', '2', *extra], capture_output=True, text=True)
        worker.join(4)
        self.assertFalse(worker.is_alive())
        self.assertFalse(worker_errors)
        return result

    def test_request_uses_dedicated_staging_and_leaves_no_temp(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.plugin / 'requests').is_dir())
        self.assertEqual(list((self.plugin / 'requests').iterdir()), [])
        self.assertEqual(list(self.plugin.glob('request-*.tmp')), [])

    def load_cli(self):
        spec = importlib.util.spec_from_file_location('scan_note', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_failed_atomic_replace_preserves_mailbox_and_cleans_temp(self):
        mailbox = self.plugin / 'request.json'
        mailbox.write_text('previous request')
        cli = self.load_cli()
        with patch.object(cli.os, 'replace', side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(SystemExit, 'Cannot submit scan request'):
                cli.publish_request(self.plugin, {'id': 'synthetic', 'file': 'synthetic.md'})
        self.assertEqual(mailbox.read_text(), 'previous request')
        self.assertEqual(list((self.plugin / 'requests').iterdir()), [])

    def test_symlink_staging_is_rejected_before_writing(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.plugin / 'requests').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(SystemExit, 'symbolic link'):
            self.load_cli().publish_request(self.plugin, {'id': 'synthetic'})
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse((self.plugin / 'request.json').exists())

    def test_legacy_no_targets_stays_schema_one(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.request['schemaVersion'], 1)
        self.assertNotIn('targets', self.request)

    def test_multiple_line_ranges_use_schema_two(self):
        result = self.invoke(['--lines', '1:1', '--lines', '3:3'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.request['schemaVersion'], 2)
        self.assertEqual([t['startLine'] for t in self.request['targets']], [1, 3])

    def test_paragraph_and_exact_line_targets(self):
        result = self.invoke(['--paragraph', '合成段落', '--lines', '3:3'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([target['kind'] for target in self.request['targets']], ['lines', 'paragraph'])

    def test_chapter_targets_are_rejected(self):
        for extra in [('--section', '章节'), ('--target', '{"kind":"section","headingPath":["章节"]}')]:
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'synthetic.md', '--vault', str(self.root), *extra], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse((self.plugin / 'request.json').exists())

    def test_uncovered_exits_nonzero(self):
        result = self.invoke(['--lines', '3:3'], status='incomplete')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['status'], 'incomplete')

    def test_wrong_archive_identity_is_rejected(self):
        result = self.invoke(wrong_id=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('identity mismatch', result.stderr)

    def test_complete_with_uncovered_target_is_rejected(self):
        result = self.invoke(['--lines', '3:3'], bad_coverage=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('coverage is incomplete', result.stderr)

    def test_wrong_target_is_rejected_even_when_response_matches_archive(self):
        def mutate(report, response):
            report['targeting']['targets'][0]['requested'] = {'kind': 'lines', 'startLine': 1, 'endLine': 1}
        result = self.invoke(['--lines', '3:3'], mutate=mutate)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Target identity mismatch', result.stderr)

    def test_response_target_list_must_match_archive(self):
        result = self.invoke(['--lines', '3:3'], mutate=lambda report, response: response.update(targets=[]))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Target identity mismatch', result.stderr)

    def test_target_scalar_types_are_not_coerced(self):
        def mutate(report, response):
            response['targets'] = json.loads(json.dumps(response['targets']))
            response['targets'][0]['requested']['startLine'] = True
        result = self.invoke(['--lines', '1:1'], mutate=mutate)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Target identity mismatch', result.stderr)

    def test_response_result_must_match_archive(self):
        result = self.invoke(['--lines', '3:3'], mutate=lambda report, response: report['targeting'].update(result='suspected'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Target result mismatch', result.stderr)

    def test_missing_response_result_is_rejected(self):
        result = self.invoke(['--lines', '3:3'], mutate=lambda report, response: response.pop('targetResult'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Target result mismatch', result.stderr)

    def test_complete_requires_each_target_covered(self):
        def mutate(report, response):
            report['targeting']['targets'][0]['coverage'] = 'uncovered'
        result = self.invoke(['--lines', '3:3'], mutate=mutate)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('coverage is incomplete', result.stderr)

    def test_suspected_is_a_successful_covered_scan(self):
        def mutate(report, response):
            report['targeting']['result'] = 'suspected'
            response['targetResult'] = 'suspected'
        result = self.invoke(['--lines', '3:3'], mutate=mutate)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['targetResult'], 'suspected')

    def test_invalid_targets_do_not_write_request(self):
        for extra in [('--lines', '0:1'), ('--lines', '2:1'), ('--lines', '1:99'),
                      ('--target', '[]'), ('--target', '{"kind":"lines","startLine":true,"endLine":2}'),
                      ('--width', 'inf')]:
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'synthetic.md', '--vault', str(self.root), *extra], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse((self.plugin / 'request.json').exists())

    def test_vault_is_still_required(self):
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'synthetic.md'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.plugin / 'request.json').exists())


    def test_visible_request_uses_actual_layout_protocol(self):
        result = self.invoke(['--visible-only', '--include-request'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.request['schemaVersion'], 3)
        self.assertEqual(self.request['scanMode'], 'visible')
        self.assertNotIn('expectedLayout', self.request)
        self.assertEqual(json.loads(result.stdout)['response']['documentCoverage'], 'not-scanned')

    def test_visible_incomplete_is_nonzero(self):
        result = self.invoke(['--visible-only'], status='incomplete')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)['visibleCoverage'], 'uncovered')

    def test_visible_rejects_identity_mode_and_coverage_tampering(self):
        mutations = [lambda r, p: p.update(file='other.md'), lambda r, p: p.update(sourceSha256='f'*64),
                     lambda r, p: p.update(schemaVersion=4), lambda r, p: r.update(schemaVersion=5),
                     lambda r, p: r.update(requestId='other-request'),
                     lambda r, p: p.update(scanMode='full'), lambda r, p: r.update(scanMode='full'),
                     lambda r, p: r['scan'].update(full=True), lambda r, p: r['scan'].update(steps=2),
                     lambda r, p: p.update(visibleCoverage='uncovered'), lambda r, p: r.update(visibleReasons=['missing']),
                     lambda r, p: r['blocks'][0].update(sourceMapping={'status': 'unmapped'}),
                     lambda r, p: r['capturedTargets'][0].update(coverage='uncovered'),
                     lambda r, p: r.update(documentCoverage='complete'),
                     lambda r, p: r.update(archivePath='other.json'),
                     lambda r, p: r['blocks'][0]['measurementUnit'].update(complete=False),
                     lambda r, p: r['capturedTargets'][0]['requested'].update(text='错误原文')]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp()
                result = self.invoke(['--visible-only'], mutate=mutate)
                self.assertNotEqual(result.returncode, 0)

    def test_note_path_is_required_and_removed_flag_is_rejected(self):
        for extra in [[], ['--visible-only'], ['--local-only'], ['--visible-active'],
                      ['synthetic.md', '--visible-active']]:
            with self.subTest(extra=extra):
                result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--vault', str(self.root), *extra], capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, '')
                self.assertIn('unrecognized arguments: --visible-active' if '--visible-active' in extra and 'synthetic.md' in extra else 'required: note', result.stderr)
                self.assertFalse((self.plugin / 'request.json').exists())

    def test_visible_stale_response_id_is_not_accepted(self):
        result = self.invoke(['--visible-only'], mutate=lambda r, p: p.update(id='stale'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No response before timeout', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_visible_source_is_checked_again_after_archive_verification(self):
        from types import SimpleNamespace
        from contextlib import redirect_stdout
        from io import StringIO
        result = self.invoke(['--visible-only'])
        self.assertEqual(result.returncode, 0, result.stderr)
        cli = self.load_cli()
        verify = cli.verify_report
        def change_after_verification(*args):
            report = verify(*args)
            self.note.write_bytes(b'changed after archive verification')
            return report
        output = StringIO()
        with patch.object(sys, 'argv', [str(SCRIPT), 'synthetic.md', '--vault', str(self.root), '--visible-only']), \
                patch.object(cli, 'publish_request'), \
                patch.object(cli.uuid, 'uuid4', return_value=SimpleNamespace(hex=self.request['id'])), \
                patch.object(cli, 'verify_report', side_effect=change_after_verification), redirect_stdout(output):
            with self.assertRaisesRegex(SystemExit, 'Source changed before response acceptance'):
                cli.main()
        self.assertEqual(output.getvalue(), '')

    def test_visible_rejects_source_changed_during_scan(self):
        result = self.invoke(['--visible-only'], mutate=lambda r, p: self.note.write_text('changed'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Source changed', result.stderr)

    def test_local_only_requires_hash_and_target(self):
        for args in [['--local-only'], ['--local-only', '--lines', '3:3'], ['--visible-only', '--lines', '3:3']]:
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'synthetic.md', '--vault', str(self.root), *args], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse((self.plugin / 'request.json').exists())

    def test_local_only_rejects_full_scan_reply(self):
        import hashlib
        result = self.invoke(['--local-only', '--lines', '3:3', '--expected-source-sha256', hashlib.sha256(self.note.read_bytes()).hexdigest()],
                             mutate=lambda r, p: r['scan'].update(full=True))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('full fallback is forbidden', result.stderr)

    def test_local_only_incomplete_measurement_cannot_pass(self):
        import hashlib
        mutations = [lambda r, p: r['blocks'][0]['measurementUnit'].update(complete=False),
                     lambda r, p: r['blocks'][0].update(sourceStartLine=1),
                     lambda r, p: r['blocks'][0].update(sourceMapping={'status': 'unmapped'}),
                     lambda r, p: p.update(blocks=99)]
        for mutate in mutations:
            self.setUp()
            result = self.invoke(['--local-only', '--lines', '3:3', '--expected-source-sha256', hashlib.sha256(self.note.read_bytes()).hexdigest()], mutate=mutate)
            self.assertNotEqual(result.returncode, 0)

    def test_local_only_target_passes_without_layout_guess(self):
        import hashlib
        result = self.invoke(['--local-only', '--lines', '3:3', '--expected-source-sha256', hashlib.sha256(self.note.read_bytes()).hexdigest()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('expectedLayout', self.request)



    def test_visible_partial_table_keeps_confirmed_edit_gate_and_archive(self):
        def mutate(report, response):
            report['capturedTargets'][0]['coverage'] = 'complete'
            report['blocks'][0]['capture'].update(eligibleForEdit=True, editReasons=[])
            report['skipped'] = [{'kind': 'table', 'coverage': 'uncovered'}]
            response['skipped'] = 1
        result = self.invoke(['--visible-only', '--include-request'], status='incomplete', mutate=mutate)
        self.assertEqual(result.returncode, 1, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out['response']['suspected'], 1)
        self.assertEqual(out['response']['visibleCoverage'], 'uncovered')
        report = json.loads((self.root / out['response']['archivePath']).read_text())
        self.assertTrue(report['blocks'][0]['capture']['eligibleForEdit'])
        self.assertEqual(report['blocks'][0]['sourceStartLine'], 3)

    def test_visible_partial_failed_measurement_is_diagnostic_not_confirmed(self):
        def mutate(report, response):
            report['blocks'][0]['capture'].update(coverage='uncovered', eligibleForEdit=False)
            report['blocks'][0]['measurementUnit'].update(complete=False, reasons=['hidden'])
            report['blocks'][0]['sourceMapping']['status'] = 'unmapped'
            response['suspected'] = 0
        result = self.invoke(['--visible-only'], status='incomplete', mutate=mutate)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)['suspected'], 0)
        self.assertEqual(json.loads(result.stdout)['visibleCoverage'], 'uncovered')

    def test_visible_partial_claims_still_require_identity_and_measurement(self):
        mutations = [lambda r, p: r['blocks'][0]['sourceMapping'].update(status='unmapped'),
                     lambda r, p: r['blocks'][0]['measurementUnit'].update(complete=False),
                     lambda r, p: r['blocks'][0].update(sourceStartLine=1),
                     lambda r, p: r['blocks'][0].update(availableWidthPx=0),
                     lambda r, p: r['blocks'][0]['capture'].update(eligibleForEdit=True),
                     lambda r, p: p.update(suspected=0),
                     lambda r, p: r.update(file='other.md')]
        for mutate in mutations:
            self.setUp()
            result = self.invoke(['--visible-only'], status='incomplete', mutate=mutate)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '', result.stderr)

    def test_visible_code_exclusion_is_accepted_but_table_exclusion_is_rejected(self):
        self.note.write_text('```\nprotected\n```')
        def mutate(report, response):
            report.update(blocks=[], capturedTargets=[], skipped=[{
                'kind': '代码块', 'coverage': 'excluded', 'key': '0:2:0', 'domPath': '0',
                'sourceStartLine': 1, 'sourceEndLine': 3, 'sourceMapping': {'status': 'mapped'}}])
            response.update(blocks=0, suspected=0, skipped=1)
        result = self.invoke(['--visible-only'], mutate=mutate)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.setUp()
        def table(report, response):
            mutate(report, response)
            report['skipped'][0]['kind'] = 'table'
        result = self.invoke(['--visible-only'], mutate=table)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exclusion identity mismatch', result.stderr)


if __name__ == '__main__':
    unittest.main()
