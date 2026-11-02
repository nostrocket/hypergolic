#!/usr/bin/env python3
"""Explicitly build, stage and repin the two reviewed unsigned SDK upload artifacts."""
import hashlib,json,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
subprocess.run(['pnpm','--dir','napplets/upload-lab','build'],cwd=ROOT,check=True)
original=(ROOT/'napplets/upload-lab/dist/index.html').read_text();assert original.count('<body>')==1
catalog=ROOT/'src/runtime/bundled-catalog.ts';text=catalog.read_text()
for name,html,title in [('upload-lab',original,'Upload Lab'),('upload-queue-lab',original.replace('<body>','<body data-upload-queue="true">'),'Upload Queue Lab')]:
    value=html.encode();digest=hashlib.sha256(value).hexdigest();aggregate=hashlib.sha256((digest+' /index.html\n').encode()).hexdigest()
    (ROOT/'runtime/fixtures'/f'{name}.html').write_bytes(value)
    record={'kind':35129,'created_at':1790859879,'tags':[['d',name],['path','/index.html',digest],['x',aggregate,'aggregate'],['requires','upload']],'content':'','aggregateHash':aggregate}
    (ROOT/'runtime/fixtures'/f'{name}-manifest.json').write_text(json.dumps(record,indent=2)+'\n')
    entry=f"  '{name}': Object.freeze({{title: '{title}', appId: '{name}',\n    sha256: '{digest}', aggregateHash: '{aggregate}', domains: Object.freeze(['upload', 'theme'])}}),"
    pattern=r"  '"+name+r"': Object.freeze\(\{.*?\}\),"
    if re.search(pattern,text,re.S):text=re.sub(pattern,lambda _:entry,text,count=1,flags=re.S)
    else:text=text.replace('export const BUNDLED_FIXTURES = Object.freeze({','export const BUNDLED_FIXTURES = Object.freeze({\n'+entry)
    print(name,digest,aggregate)
catalog.write_text(text)
