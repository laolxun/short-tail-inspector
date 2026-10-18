"""Codex caller contract in temporary synthetic notes, not an automatic editor.

Exercises bottom-up edits, shifted exact source identities and the real CLI's
request/acceptance checks. Semantic rewrite quality still requires human review.
"""
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent
legacy = runpy.run_path(str(HERE / 'scan-note-test.py'))


class VisibleWorkflowTests(unittest.TestCase):
    setUp = legacy['CLITests'].setUp
    invoke = legacy['CLITests'].invoke

    def args(self, targets, sha=None):
        args = ['--local-only', '--include-request', '--expected-source-sha256',
                sha or hashlib.sha256(self.note.read_bytes()).hexdigest()]
        for target in targets:
            args.extend(['--target', json.dumps(target, ensure_ascii=False)])
        return args

    def test_two_edits_shift_lines_and_recheck_only_changed_targets(self):
        original = '# 标题\n\n第一段冗余表达\n\n第二段冗余表达\n\n不应修改的相邻段落\n'
        self.note.write_text(original)
        before_sha = hashlib.sha256(self.note.read_bytes()).hexdigest()
        # These are caller-approved whole source paragraphs from one capture.
        edits = [(3, 3, '第一段冗余表达', '第一段\n精简正文'),
                 (5, 5, '第二段冗余表达', '第二段精简正文')]
        lines = original.split('\n')
        for start, end, before, after in reversed(edits):
            self.assertEqual('\n'.join(lines[start - 1:end]), before)
            lines[start - 1:end] = after.split('\n')
        self.note.write_text('\n'.join(lines))
        self.assertEqual(lines[7], '不应修改的相邻段落')
        targets, delta = [], 0
        for start, end, before, after in edits:
            new_start = start + delta
            new_end = new_start + len(after.split('\n')) - 1
            self.assertEqual('\n'.join(lines[new_start - 1:new_end]), after)
            targets.append(dict(kind='lines', startLine=new_start, endLine=new_end, text=after))
            delta += len(after.split('\n')) - (end - start + 1)
        result = self.invoke(self.args(targets))
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertNotEqual(out['request']['expectedSourceSha256'], before_sha)
        self.assertEqual(out['request']['targets'], targets)
        self.assertEqual([t['startLine'] for t in targets], [3, 6])
        self.assertEqual([t['requested'] for t in out['response']['targets']], targets)
        self.assertEqual(out['response']['scanMethod'], 'visible')
        self.assertEqual(out['response']['documentCoverage'], 'not-scanned')

    def test_shifted_old_range_or_old_hash_never_publishes(self):
        old_sha = hashlib.sha256(self.note.read_bytes()).hexdigest()
        self.note.write_text('新增行\n' + self.note.read_text())
        target = dict(kind='lines', startLine=3, endLine=3, text='合成段落')
        for args in [self.args([target]), self.args([target], old_sha)]:
            result = subprocess.run([sys.executable, '-B', str(HERE.parent / 'scan-note.py'),
                                     'synthetic.md', '--vault', str(self.root), *args], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.plugin / 'request.json').exists())

    def test_missing_or_ambiguous_text_is_not_guessed(self):
        result = subprocess.run([sys.executable, '-B', str(HERE.parent / 'scan-note.py'),
                                 'synthetic.md', '--vault', str(self.root),
                                 '--local-only', '--paragraph', '合成段落', '--expected-source-sha256',
                                 hashlib.sha256(self.note.read_bytes()).hexdigest()], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.plugin / 'request.json').exists())


if __name__ == '__main__':
    unittest.main()
