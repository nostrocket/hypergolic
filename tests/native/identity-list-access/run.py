#!/usr/bin/env python3
"""Compile production native list-access registries; this is logic evidence, not a WebView journey."""
import argparse,hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
java='modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/IdentityListAccessRegistry.java';swift='modules/napplet-host/ios/IdentityListAccess.swift';suite='tests/native/identity-list-access/'
files=[java,swift,suite+'IdentityListAccessProof.java',suite+'IdentityListAccessProof.swift']
def hashes():return {f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files}
r={'kind':'native-identity-list-access-logic-v1','sourceBefore':hashes(),'status':'running','results':[]}
try:
 commands=[['javac','-Xlint:all','-Werror','-d',str(a.output),str(ROOT/java),str(ROOT/(suite+'IdentityListAccessProof.java'))],['java','-cp',str(a.output),'IdentityListAccessProof'],['xcrun','swiftc','-swift-version','6','-warnings-as-errors','-parse-as-library',str(ROOT/swift),str(ROOT/(suite+'IdentityListAccessProof.swift')),'-o',str(a.output/'swift-proof')],[str(a.output/'swift-proof')]]
 for cmd in commands:
  result=subprocess.run(cmd,text=True,capture_output=True);r['results'].append({'command':cmd,'exitCode':result.returncode,'stdout':result.stdout,'stderr':result.stderr});print(result.stdout,end='');assert result.returncode==0,result.stderr
 r['sourceAfter']=hashes();assert r['sourceBefore']==r['sourceAfter'];r['status']='passed'
except Exception as error:r.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
