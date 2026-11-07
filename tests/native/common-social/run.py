#!/usr/bin/env python3
"""Compile actual Common native plans and approval source captures; no app install, signer or public socket."""
from pathlib import Path
import argparse,hashlib,json,os,subprocess
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
HOST=ROOT/'modules/napplet-host'
A=HOST/'android'
I=HOST/'ios'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
 out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
 names=['NativeCommonPlan','NativeCommonNpub','NativeOutboxPlan','NativeApprovalSigningData','CapabilityConfiguration','ApprovalTransport','NappletHostView','NappletHostModule']
 files=[*(A/'src/main/java/org/nostrocket/hypergolic/host'/(n+'.kt') for n in names),*(I/(n+'.swift') for n in ['NativeCommonPlan','NativeCommonNpub','NativeOutboxPlan','ApprovalTransport','CapabilityTransport','NappletHostModule']),HERE/'NativeCommonProof.kt',HERE/'NativeCommonProof.swift',HERE/'make-fixtures.mjs',Path(__file__)]
 before={str(p.relative_to(ROOT)):sha(p) for p in files};receipt={'status':'failed','sourceBefore':before,'scope':__doc__}
 def run(name,cmd,cwd=ROOT):
  with (out/(name+'.log')).open('w') as log:subprocess.run(list(map(str,cmd)),cwd=cwd,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=300)
 try:
  run('fixtures',['node','--experimental-strip-types',HERE/'make-fixtures.mjs',out/'fixtures.json'])
  run('android-module-compile',['./gradlew',':hypergolic-napplet-host:compileReleaseJavaWithJavac','--offline','--console=plain'],ROOT/'android')
  cache=ROOT/'.tools/gradle-home/caches/modules-2/files-2.1'
  def jar(g,n,v):
   values=list((cache/g/n/v).glob('*/*.jar'));assert len(values)==1;return values[0]
  compiler=[jar(*p) for p in [('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.kotlin','kotlin-daemon-embeddable','2.2.21'),('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','23.0.0')]]
  classes=[A/'build/tmp/kotlin-classes/release',A/'build/intermediates/javac/release/compileReleaseJavaWithJavac/classes'];proof=out/'classes';proof.mkdir()
  classpath=os.pathsep.join(map(str,[*classes,jar('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),jar('org.json','json','20180813'),proof]))
  run('android-proof-compile',['java','-cp',os.pathsep.join(map(str,compiler)),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-Werror','-no-stdlib','-no-reflect','-jvm-target','17','-Xfriend-paths='+str(classes[0]),'-classpath',classpath,'-d',proof,HERE/'NativeCommonProof.kt'])
  run('android-proof',['java','-cp',classpath,'org.nostrocket.hypergolic.host.NativeCommonProofKt',out/'fixtures.json'])
  executable=out/'swift-proof'
  run('swift-proof-compile',['swiftc','-swift-version','6','-parse-as-library',*(I/(n+'.swift') for n in ['NativeCommonPlan','NativeCommonNpub','NativeOutboxPlan','PublishedRelayWebSocketClientFrames']),HERE/'NativeCommonProof.swift','-o',executable])
  run('swift-proof',[executable,out/'fixtures.json']);receipt['sourceAfter']={str(p.relative_to(ROOT)):sha(p) for p in files};assert before==receipt['sourceAfter'];receipt['status']='passed'
 finally:
  receipt['logs']={p.name:sha(p) for p in out.glob('*.log')};(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
if __name__=='__main__':main()
