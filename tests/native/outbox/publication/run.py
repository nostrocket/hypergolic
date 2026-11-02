#!/usr/bin/env python3
"""Compile actual native Outbox plan/approval/WSS owners. No device or protected-signing proof."""
import argparse,hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
HERE=Path(__file__).resolve().parent
ANDROID=ROOT/'modules/napplet-host/android'
IOS=ROOT/'modules/napplet-host/ios'
A_NAMES=['NativeSigningHold.java','OutboxResponseJson.java','UploadJsonBounds.java','OutboxAcknowledgement.kt','NativeOutboxPlan.kt','OutboxPublicationOwner.kt','ApprovalTransport.kt','ApprovalLeaseRegistry.java','NativeApprovalAuthority.java','PublishedRelayWssQuery.java','PublishedRelayWssIo.java','PublishedRelayResponseClassifier.java']
I_NAMES=['NativeUploadAuthority.swift','UploadFileProfile.swift','UploadPngMetadata.swift','UploadPngProfile.swift','NativeOutboxPlan.swift','OutboxAcknowledgement.swift','OutboxPublicationOwner.swift','NativeApprovalAuthority.swift','CapabilityLeaseRegistry.swift','ApprovalTransport.swift','PublicAddressPolicy.swift','PublishedHTTPResponse.swift','PublishedPinnedHTTPS.swift','PublishedRelayWebSocketHandshake.swift','PublishedRelayWebSocketFrames.swift','NativeSignerRelayPolicy.swift','PublishedRelayWebSocketClientFrames.swift','PublishedRelayWebSocketQuery.swift','PublishedRelayEnvelope.swift']
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def inputs():
    files=[*(ANDROID/'src/main/java/org/nostrocket/hypergolic/host'/p for p in A_NAMES),*(IOS/p for p in I_NAMES),HERE/'fixtures.json',HERE/'PlanProof.java',HERE/'PlanProof.swift',Path(__file__)]
    return {str(p.relative_to(ROOT)):sha(p) for p in files}
def run(command,root,name,cwd=ROOT):
    with (root/(name+'.log')).open('w') as log:subprocess.run(command,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=300)
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False);before=inputs();receipt={'status':'failed','sourceBefore':before,'scope':__doc__}
    try:
        run(['./gradlew',':hypergolic-napplet-host:compileReleaseJavaWithJavac','--offline','--console=plain'],out,'android-compile',ROOT/'android')
        cache=ROOT/'.tools/gradle-home/caches/modules-2/files-2.1'
        jars=[next((cache/'org.json/json/20180813').rglob('*.jar')),next((cache/'org.jetbrains.kotlin/kotlin-stdlib/2.1.20').rglob('*.jar'))]
        classes=[ANDROID/'build/tmp/kotlin-classes/release',ANDROID/'build/intermediates/javac/release/compileReleaseJavaWithJavac/classes']
        (out/'classes').mkdir()
        classpath=os.pathsep.join(map(str,[*classes,*jars,out/'classes']))
        run(['javac','-Xlint:all','-Werror','-cp',classpath,'-d',str(out/'classes'),str(HERE/'PlanProof.java')],out,'android-proof-compile')
        run(['java','-cp',classpath,'org.nostrocket.hypergolic.host.PlanProof',str(HERE/'fixtures.json')],out,'android-proof')
        run(['xcrun','swiftc','-swift-version','6','-warnings-as-errors','-parse-as-library',*(str(IOS/p) for p in I_NAMES),str(HERE/'PlanProof.swift'),'-o',str(out/'ios-proof')],out,'ios-compile')
        run([str(out/'ios-proof'),str(HERE/'fixtures.json')],out,'ios-proof')
        receipt['sourceAfter']=inputs();assert receipt['sourceBefore']==receipt['sourceAfter'],'Native sources changed during proof'
        receipt['proofs']=[json.loads((out/(name+'.log')).read_text().strip()) for name in ['android-proof','ios-proof']]
        receipt['status']='passed'
    finally:
        receipt['logs']={p.name:sha(p) for p in out.glob('*.log')}
        (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'status':receipt['status'],'proofs':receipt['proofs'],'receipt':str(out/'receipt.json')}))
if __name__=='__main__':main()
