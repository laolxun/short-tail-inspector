"""Consume browser test captures; simulate only the request wrapper, never Obsidian."""
import json
from pathlib import Path
import runpy
import sys

verify = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scan-note.py'))['verify_scoped_identity']
rows = json.load(sys.stdin)
for row in rows:
    report = row['report']
    # pollRequest normally adds these after scanVisible returns.
    report.update(localOnly=False, archivePath='synthetic.json',
                  layout=dict(contentWidthPx=300, fontSizePx=16, sidebarsClosed=True))
    request = dict(scanMode='visible', file=report['file'], expectedSourceSha256=report['sourceSha256'])
    response = dict(schemaVersion=3, file=report['file'], sourceSha256=report['sourceSha256'],
                    scanMode='visible', localOnly=False, scanMethod='visible',
                    documentCoverage='not-scanned', completionScope='viewport',
                    archivePath='synthetic.json', visibleCoverage=report['visibleCoverage'],
                    status='complete' if report['visibleCoverage'] == 'complete' else 'incomplete',
                    blocks=len(report['blocks']), skipped=len(report['skipped']), suspected=row['confirmed'])
    try:
        verify(response, request, report, row['source'])
    except SystemExit as error:
        raise SystemExit(row['name'] + ': ' + str(error))
print('Python accepted browser-produced visible reports:', len(rows))
