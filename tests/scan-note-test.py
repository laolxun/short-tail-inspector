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
                if request['schemaVersion'] == 2:
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


if __name__ == '__main__':
    unittest.main()
