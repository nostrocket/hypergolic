#!/usr/bin/env python3
"""Compile actual native Mesh authority + canonical JSON helpers; no signer/socket/device operation."""
import argparse,hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
A=ROOT/'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
I=ROOT/'modules/napplet-host/ios'
CACHE=ROOT/'.tools/gradle-home/caches/modules-2/files-2.1'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def jar(group,name,version):
    matches=list((CACHE/group/name/version).glob('*/*.jar'))
    assert len(matches)==1,(group,name,version)
    return matches[0]
def expected_vectors():
    domain=b'hypergolic.mesh.pairing.v1\0'
    fields=bytes(range(1,17))+bytes(range(1,225))+(1794090000).to_bytes(8,'big')
    same_fields=fields[:48]+bytes(range(33,65))*2+fields[112:]
    user='1'*64
    canonical=json.dumps([0,user,1794089880,20431,[['t','é/é/雪😃']],'quote"/\\\n'],ensure_ascii=False,separators=(',',':'))
    event={'id':hashlib.sha256(canonical.encode()).hexdigest(),'pubkey':user,'created_at':1794089880,'kind':20431,'tags':[['t','é/é/雪😃']],'content':'quote"/\\\n','sig':'0'*128}
    empty={'id':'0'*64,'pubkey':user,'created_at':1794089880,'kind':1,'tags':[],'content':'','sig':'0'*128}
    return {'publicationCanonical':canonical,'publicationEventId':event['id'],'publicationFrame':json.dumps(['EVENT',event],ensure_ascii=False,separators=(',',':')),
      'pairingInviterTranscript':(domain+b'\1'+fields).hex(),'pairingJoinerTranscript':(domain+b'\2'+fields).hex(),
      'pairingInviterSignedBinding':(domain+b'\1'+fields+bytes(64)).hex(),
      'sameAccountInviterDigest':hashlib.sha256(domain+b'\1'+same_fields).hexdigest(),
      'sameAccountJoinerDigest':hashlib.sha256(domain+b'\2'+same_fields).hexdigest(),
      'frameContentMaximum':str(8192-len(json.dumps(['EVENT',empty],separators=(',',':')).encode()))}
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',required=True,type=Path);p.add_argument('--gradle-cache',type=Path,default=ROOT/'.tools/gradle-home/caches/modules-2/files-2.1');p.add_argument('--java-home',type=Path,default=ROOT/'.tools/jdk/Contents/Home');args=p.parse_args();
    global CACHE
    CACHE=args.gradle_cache;jvm=args.java_home/'bin/java';javac=args.java_home/'bin/javac';out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    files=[A/'NativeMeshAuthority.java',A/'NativeCanonicalJSON.kt',I/'NativeMeshAuthority.swift',I/'NativeCanonicalJSON.swift',HERE/'AuthorityProof.java',HERE/'AuthorityProof.swift',HERE/'vectors.json',Path(__file__)]
    receipt={'status':'failed','scope':__doc__,'sourceBefore':{str(f.relative_to(ROOT)):sha(f)for f in files},'steps':[]}
    def run(name,cmd):
        with(out/(name+'.log')).open('w')as log:result=subprocess.run(list(map(str,cmd)),cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,timeout=180)
        receipt['steps'].append({'name':name,'exitCode':result.returncode,'command':list(map(str,cmd)),'logSha256':sha(out/(name+'.log'))});assert result.returncode==0,name
    try:
        classes=out/'classes';classes.mkdir();stdlib=jar('org.jetbrains.kotlin','kotlin-stdlib','2.2.21')
        compiler=[jar(*row) for row in [('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.kotlin','kotlin-daemon-embeddable','2.2.21'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','23.0.0')]]
        receipt['compilerDependencies']={str(f):sha(f)for f in compiler};cp=os.pathsep.join(map(str,[classes,stdlib]))
        run('kotlin-helper',[jvm,'-cp',os.pathsep.join(map(str,compiler)),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-Werror','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',cp,'-d',classes,A/'NativeCanonicalJSON.kt'])
        run('java-compile',[javac,'--release','17','-Xlint:all','-Werror','-cp',cp,'-d',classes,A/'NativeMeshAuthority.java',HERE/'AuthorityProof.java'])
        run('java-proof',[jvm,'-cp',cp,'org.nostrocket.hypergolic.host.AuthorityProof'])
        run('swift-compile',['xcrun','swiftc','-swift-version','6','-warnings-as-errors','-parse-as-library','-module-cache-path',out/'swift-cache',I/'NativeCanonicalJSON.swift',I/'NativeMeshAuthority.swift',HERE/'AuthorityProof.swift','-o',out/'swift-proof'])
        run('swift-proof',[out/'swift-proof'])
        receipt['results']=[json.loads((out/(name+'.log')).read_text())for name in ['java-proof','swift-proof']]
        expected=expected_vectors();assert json.loads((HERE/'vectors.json').read_text())['expected']==expected
        for result in receipt['results']:assert result['vectors']==expected
        receipt['independentPythonVectors']=expected;receipt['status']='passed'
    finally:
        receipt['sourceAfter']={str(f.relative_to(ROOT)):sha(f)for f in files};receipt['sourceUnchanged']=receipt['sourceBefore']==receipt['sourceAfter']
        if not receipt['sourceUnchanged']:receipt['status']='failed'
        (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(receipt['status'])
if __name__=='__main__':main()
