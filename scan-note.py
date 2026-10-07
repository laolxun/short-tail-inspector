#!/usr/bin/env python3
"""Ask the installed local plugin to scan an already open note; no screenshots."""
from pathlib import Path
import argparse, hashlib, json, os, time, uuid
p=argparse.ArgumentParser()
p.add_argument('note',help='Vault-relative note path')
p.add_argument('--vault',required=True,help='Path to the target vault root')
p.add_argument('--width',type=float,default=700)
p.add_argument('--font-size',type=float,default=16)
p.add_argument('--timeout',type=float,default=30)
a=p.parse_args()
root=Path(a.vault).resolve(); note=(root/a.note).resolve()
if not note.is_relative_to(root) or not note.is_file():p.error('Note must exist inside the vault')
plugin=root/'.obsidian/plugins/short-tail-inspector'
if not (plugin/'main.js').is_file():p.error('Plugin is not installed')
request={'schemaVersion':1,'id':uuid.uuid4().hex,'action':'scan','file':note.relative_to(root).as_posix(),'expectedSourceSha256':hashlib.sha256(note.read_bytes()).hexdigest(),'expectedLayout':{'contentWidthPx':a.width,'fontSizePx':a.font_size},'temporaryReadingLayout':True,'expiresAt':int((time.time()+a.timeout)*1000)}
tmp=plugin/('request-'+request['id']+'.tmp')
tmp.write_text(json.dumps(request,ensure_ascii=False));os.replace(tmp,plugin/'request.json')
end=time.monotonic()+a.timeout
while time.monotonic()<end:
    try:
        response=json.loads((plugin/'response.json').read_text())
        if response.get('id')==request['id']:
            print(json.dumps(response,ensure_ascii=False,indent=2))
            raise SystemExit(0 if response['status']=='complete' else 1)
    except (FileNotFoundError,json.JSONDecodeError):pass
    time.sleep(.3)
raise SystemExit('No response before timeout; verify that Obsidian and the plugin are running')
