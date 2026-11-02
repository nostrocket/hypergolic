#!/usr/bin/env python3
"""Compile owning Android/iOS URL and lifetime cores; synthetic cases are not OS handoff proof."""
import base64,json,os,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='hg-link-unit-') as tmp:
    out=Path(tmp); rows=json.loads((ROOT/'tests/native/links/url-vectors.json').read_text())
    vectors=out/'vectors.tsv';vectors.write_text(''.join(base64.b64encode(r['url'].encode()).decode()+'\t'+(r['error'] or 'ok')+'\n' for r in rows))
    android=ROOT/'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
    subprocess.run(['javac','-d',str(out),str(android/'LinkUrl.java'),str(android/'LinkLeaseRegistry.java'),str(ROOT/'tests/native/links/LinkCoreTests.java')],check=True)
    subprocess.run(['java','-cp',str(out),'org.nostrocket.hypergolic.host.LinkCoreTests',str(vectors)],check=True)
    ios=ROOT/'modules/napplet-host/ios'
    subprocess.run(['xcrun','swiftc',str(ios/'LinkUrl.swift'),str(ios/'LinkLeaseRegistry.swift'),str(ROOT/'tests/native/links/LinkCoreTests.swift'),'-o',str(out/'ios-proof')],check=True)
    subprocess.run([str(out/'ios-proof'),str(vectors)],check=True)
