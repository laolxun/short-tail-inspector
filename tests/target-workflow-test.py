"""Caller acceptance tests in synthetic temporary mailboxes; no real Vault."""
from pathlib import Path
import hashlib
import json
import runpy
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent
legacy_tests = runpy.run_path(str(HERE / 'scan-note-test.py'))
SCRIPT = HERE.parent / 'scan-note.py'


class TargetWorkflowTests(unittest.TestCase):
    setUp = legacy_tests['CLITests'].setUp
    invoke = legacy_tests['CLITests'].invoke

    def guarded_args(self):
        return ['--lines', '1:4',
                '--expected-source-sha256', hashlib.sha256(self.note.read_bytes()).hexdigest(),
                '--include-request']

    def guarded(self, mutate=None, **kwargs):
        def response(report, reply):
            target = report['targeting']['targets'][0]
            target.update(resolved=True, ranges=[{'startLine': 1, 'endLine': 4}], expected=[{'startLine': 1, 'endLine': 1, 'type': 'paragraph'}])
            report['scan'] = {'full': True, 'complete': True}
            report['targeting'].update(completionScope='targets', scanMethod='full')
            reply.update(sourceSha256=report['sourceSha256'], completionScope='targets', scanMethod='full')
            if mutate:
                mutate(report, reply)
        return self.invoke(self.guarded_args(), mutate=response, **kwargs)

    def test_covered_preserves_original_request_and_raw_response(self):
        result = self.guarded()
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['request'], self.request)
        self.assertEqual(output['response']['id'], self.request['id'])
        self.assertEqual(output['response']['targetCoverage'], 'complete')
        self.assertEqual(output['response']['targets'][0]['ranges'], [{'startLine': 1, 'endLine': 4}])
        self.assertEqual(self.request['targets'][0]['kind'], 'lines')

    def test_full_complete_with_uncovered_target_is_not_covered(self):
        result = self.guarded(status='incomplete')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)['response']['targetCoverage'], 'uncovered')

    def test_visible_complete_is_covered_without_full_complete(self):
        def mutate(report, reply):
            report['scan'] = {'full': False, 'complete': False}
            report['targeting']['scanMethod'] = reply['scanMethod'] = 'visible'
        result = self.guarded(mutate)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_resolved_range_is_rejected(self):
        result = self.guarded(lambda report, reply: report['targeting']['targets'][0].update(
            ranges=[{'startLine': 1, 'endLine': 3}]))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Target range', result.stderr)

    def test_boolean_line_number_is_not_an_integer_range(self):
        result = self.guarded(lambda report, reply: report['targeting']['targets'][0].update(
            ranges=[{'startLine': True, 'endLine': 4}]))
        self.assertNotEqual(result.returncode, 0)

    def test_complete_requires_resolved_target(self):
        result = self.guarded(lambda report, reply: report['targeting']['targets'][0].update(resolved=False))
        self.assertNotEqual(result.returncode, 0)

    def test_response_hash_must_match_original_request(self):
        result = self.guarded(lambda report, reply: reply.update(sourceSha256='f' * 64))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('sourceSha256', result.stderr)

    def test_wrong_archive_identity_is_rejected(self):
        result = self.guarded(wrong_id=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('identity mismatch', result.stderr)

    def test_wrong_target_identity_is_rejected(self):
        result = self.guarded(lambda report, reply: report['targeting']['targets'][0].update(
            requested={'kind': 'lines', 'startLine': 2, 'endLine': 4}))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Target identity', result.stderr)

    def test_archive_file_and_source_identity_are_checked(self):
        for field, value in [('file', 'other.md'), ('sourceSha256', 'a' * 64)]:
            with self.subTest(field=field):
                if (self.plugin / 'request.json').exists():
                    self.setUp()
                result = self.guarded(lambda report, reply: report.update({field: value}))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('identity mismatch: ' + field, result.stderr)

    def test_stale_response_id_is_not_accepted(self):
        result = self.guarded(lambda report, reply: reply.update(id='stale-request'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No response before timeout', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_ambiguous_or_missing_target_retains_uncovered_evidence(self):
        def mutate(report, reply):
            report['targeting']['targets'][0].update(resolved=False, ranges=[])
        result = self.guarded(mutate, status='incomplete')
        self.assertEqual(result.returncode, 1, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['response']['targetCoverage'], 'uncovered')
        self.assertEqual(output['response']['targets'][0]['ranges'], [])

    def test_suspected_is_covered_without_becoming_clear(self):
        def mutate(report, reply):
            report['targeting']['result'] = reply['targetResult'] = 'suspected'
        result = self.guarded(mutate)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['response']['targetCoverage'], 'complete')
        self.assertEqual(output['response']['targetResult'], 'suspected')

    def test_error_does_not_produce_covered(self):
        result = self.guarded(status='error')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)['response']['status'], 'error')

    def test_scope_and_method_must_match_archive(self):
        for field, value in [('completionScope', 'full'), ('scanMethod', 'visible')]:
            with self.subTest(field=field):
                # Each invocation owns an independent synthetic mailbox.
                if (self.plugin / 'request.json').exists():
                    self.setUp()
                result = self.guarded(lambda report, reply: reply.update({field: value}))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('mismatch', result.stderr)

    def test_full_fallback_incomplete_cannot_be_covered(self):
        result = self.guarded(lambda report, reply: report['scan'].update(complete=False))
        self.assertNotEqual(result.returncode, 0)

    def scoped_complete(self, report, reply):
        report['scan'].update(complete=False, missingSourceLocations=True)
        report['documentCoverage'] = reply['documentCoverage'] = 'incomplete'
        report['targeting']['coverageBasis'] = 'target-source-blocks-v1'
        report['targeting']['targets'][0].update(
            expected=[{'startLine': 3, 'endLine': 3, 'type': 'paragraph'}],
            reasons=[], mappingGaps=[], measuredBlocks=1)

    def test_complete_target_accepts_incomplete_document_with_scoped_evidence(self):
        result = self.guarded(self.scoped_complete)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['response']['targetCoverage'], 'complete')
        self.assertEqual(output['response']['documentCoverage'], 'incomplete')

    def test_document_coverage_mismatch_is_rejected(self):
        def mutate(report, reply):
            self.scoped_complete(report, reply)
            reply['documentCoverage'] = 'complete'
        result = self.guarded(mutate)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Document coverage mismatch', result.stderr)

    def test_scoped_complete_requires_target_evidence(self):
        for field, value in [('mappingGaps', [{'kind': 'text', 'possibleRange': None}]),
                             ('expected', []), ('reasons', ['缺少映射']), ('measuredBlocks', 0)]:
            with self.subTest(field=field):
                if (self.plugin / 'request.json').exists():
                    self.setUp()
                def mutate(report, reply):
                    self.scoped_complete(report, reply)
                    report['targeting']['targets'][0][field] = value
                result = self.guarded(mutate)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('coverage evidence is incomplete', result.stderr)

    def test_source_change_before_request_writes_nothing(self):
        args = self.guarded_args()
        self.note.write_text('标题\n新内容\n合成段落\n结束\n', encoding='utf-8')
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'synthetic.md',
                                 '--vault', str(self.root), *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('Source changed', result.stderr)
        self.assertFalse((self.plugin / 'request.json').exists())

    def test_source_change_after_scan_is_rejected(self):
        def mutate(report, reply):
            self.note.write_text('新内容\n', encoding='utf-8')
        result = self.guarded(mutate)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Source changed', result.stderr)



if __name__ == '__main__':
    unittest.main()
