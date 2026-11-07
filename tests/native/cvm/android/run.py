#!/usr/bin/env python3
"""Compile the actual CVM Android path and run owned, host-side native contract proofs.
No device, provider, vault or app installation. The explicit ABI input comes from a normal native build.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT=Path(__file__).resolve().parents[4]
JAVA_NAMES=['NativeCvmEnvelope','NativeCvmLifetime','NativeCvmProtocol','NativeCvmSessions']
HOST_NAMES=['NativeCvmServiceAuthority','NativeCvmSourceFacade','NativeSignerRelay','NativeSignerRelayOpening',
            'NativeResolverOwnership','PublishedRelayWssIo','PublishedCapabilityBinding']
KOTLIN_NAMES=['NativeCanonicalJSON','NativeAppDataPolicy','CvmTransport','CapabilityConfiguration','NappletHostView','NappletHostModule']

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--abi-dir',type=Path,required=True)
    parser.add_argument('--toolchain-root',type=Path,default=ROOT)
    args=parser.parse_args();out=args.output.absolute();assert not out.exists(),'Use fresh output'
    out.mkdir(parents=True);tools=args.toolchain_root.resolve();abi=args.abi_dir.resolve();jdk=tools/'.tools/jdk/Contents/Home'
    cache=tools/'.tools/gradle-home/caches/modules-2/files-2.1';fixture=Path(__file__).resolve().parent
    signer=ROOT/'modules/signer-core';src=signer/'android/src/main/java/org/nostrocket/hypergolic/signercore'
    host=ROOT/'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
    classes=out/'owned';classes.mkdir();runtime=out/'fixtures';runtime.mkdir();proofs={}
    def jar(group,name,version):
        values=list((cache/group/name/version).glob('*/*.jar'));assert len(values)==1,(group,name,version);return values[0]
    def extract(group,name,version,label):
        values=list((cache/group/name/version).glob('*/*.aar'));assert len(values)==1
        path=out/(label+'.jar')
        with zipfile.ZipFile(values[0])as archive:path.write_bytes(archive.read('classes.jar'))
        return path
    def run(command,label):
        result=subprocess.run(list(map(str,command)),capture_output=True,text=True,timeout=120)
        (out/(label+'.log')).write_text(result.stdout+result.stderr)
        proofs[label]={'exit':result.returncode};assert result.returncode==0,label
    sdk=tools/'.tools/android-sdk/platforms/android-37.0/android.jar'
    cp=[classes,sdk]+[abi/(module+'-'+language)for module in ['signer-core','napplet-host','identity-owner']for language in ['kotlin','java']]
    cp += [abi/'expo-core.jar',abi/'react-android.jar',abi/'expo-modules-v2-react.jar',extract('androidx.webkit','webkit','1.17.0','webkit'),
           jar('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),jar('org.jetbrains','annotations','23.0.0'),jar('androidx.annotation','annotation-jvm','1.9.1'),
           jar('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0')]
    assert all(path.exists()for path in cp)
    java=[src/(name+'.java')for name in JAVA_NAMES]+[host/(name+'.java')for name in HOST_NAMES]
    kotlin=[src/'SignerCoreModule.kt']+[host/(name+'.kt')for name in KOTLIN_NAMES]
    inputs={str(path.relative_to(ROOT)):digest(path)for path in java+kotlin+list(fixture.rglob('*.java'))+list(fixture.glob('*.kt'))}
    run([jdk/'bin/javac','-Xlint:all','-Werror','-cp',os.pathsep.join(map(str,cp)),'-d',classes,*java],'owned-java')
    compiler=[jar(*value)for value in [('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.2.21'),('org.jetbrains.kotlin','kotlin-stdlib','2.2.21'),
       ('org.jetbrains.kotlin','kotlin-script-runtime','2.2.21'),('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),('org.jetbrains.kotlin','kotlin-daemon-embeddable','2.2.21'),
       ('org.jetbrains.intellij.deps','trove4j','1.0.20200330'),('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),('org.jetbrains','annotations','23.0.0')]]
    def compile_kotlin(files,destination,classpath,label):
        run([jdk/'bin/java','-cp',os.pathsep.join(map(str,compiler)),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-Werror','-no-stdlib','-no-reflect','-jvm-target','17',
           '-Xfriend-paths='+','.join(str(path)for path in classpath if path.is_dir()),'-classpath',os.pathsep.join(map(str,classpath)),'-d',destination,*files],label)
    compile_kotlin(kotlin,classes,cp,'owned-kotlin-and-expo')
    run([jdk/'bin/javac','-Xlint:all','-Werror','-d',runtime,*fixture.glob('fixtures/android/os/*.java')],'fixture-clock-main')
    runtime_cp=[runtime,classes,jar('org.json','json','20180813')]+[path for path in cp if path.is_dir()and path!=classes]+[jar('org.jetbrains.kotlin','kotlin-stdlib','2.2.21')]
    compile_kotlin([fixture/'CvmHostFixture.kt'],runtime,runtime_cp,'fixture-host')
    run([jdk/'bin/javac','-Xlint:all','-Werror','-cp',os.pathsep.join(map(str,runtime_cp)),'-d',runtime,fixture/'NativeCvmComposedProof.java',fixture/'CvmReadTurnProof.java',fixture/'CvmDeliveryRevisionProof.java'],'fixture-actors')
    for mode in ['', 'uncertain','admission-race']:
        run([jdk/'bin/java','-ea','-cp',os.pathsep.join(map(str,runtime_cp)),'org.nostrocket.hypergolic.signercore.NativeCvmComposedProof',*([mode]if mode else [])],'actor-'+(mode or 'composed'))
    for name in ['CvmReadTurnProof','CvmDeliveryRevisionProof']:
        run([jdk/'bin/java','-ea','-cp',os.pathsep.join(map(str,runtime_cp)),'org.nostrocket.hypergolic.host.'+name],name)
    crypto=out/'crypto';crypto.mkdir();cmake=shutil.which('cmake');assert cmake
    configure=[cmake,'-S',signer/'shared','-B',crypto/'c','-DCMAKE_BUILD_TYPE=Release']
    if sys.platform=='darwin':configure.append('-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0')
    run(configure,'crypto-cmake');run([cmake,'--build',crypto/'c','-j','2'],'crypto-c')
    library=crypto/('libhypergolic_signer_jni.dylib'if sys.platform=='darwin'else 'libhypergolic_signer_jni.so')
    run(['clang','-dynamiclib'if sys.platform=='darwin'else '-shared','-O2','-I'+str(jdk/'include'),'-I'+str(jdk/('include/darwin'if sys.platform=='darwin'else 'include/linux')),
         '-I'+str(signer/'shared/include'),signer/'android/src/main/cpp/signer_jni.c',crypto/'c/libhypergolic_signer.a','-o',library],'crypto-jni')
    crypto_classes=crypto/'classes';crypto_classes.mkdir();crypto_cp=[crypto_classes,jar('org.json','json','20180813'),jar('com.google.code.gson','gson','2.11.0'),abi/'signer-core-java',abi/'napplet-host-java']
    crypto_java=[src/(name+'.java')for name in ['NativeSigningKey','NativeSecretBuffer','NativeEvent','NativeRpcJson','NativeSignedEvent','NativeCvmEnvelope']]
    run([jdk/'bin/javac','-Xlint:all','-Werror','-cp',os.pathsep.join(map(str,crypto_cp)),'-d',crypto_classes,*crypto_java,fixture/'CvmEnvelopeRuntimeProof.java',*fixture.glob('fixtures/android/util/*.java')],'crypto-java')
    run([jdk/'bin/java','-ea','-Djava.library.path='+str(crypto),'-cp',os.pathsep.join(map(str,crypto_cp)),'org.nostrocket.hypergolic.signercore.CvmEnvelopeRuntimeProof'],'crypto-runtime')
    for name,sha in inputs.items():assert digest(ROOT/name)==sha,name
    (out/'source-inputs.json').write_text(json.dumps(inputs,indent=2)+'\n')
    (out/'receipt.json').write_text(json.dumps({'status':'passed-host-compiled-native-contracts','scope':'Actual owned Android Java/Kotlin/Expo/View compiled; controlled WSS/codec for lifecycle; real Java/JNI/C crypto with testJsonReader adapter. Not APK/platform/parser/provider/device acceptance.',
       'proofs':proofs,'sourceFiles':len(inputs),'providerOrVaultOrDeviceActions':False},indent=2)+'\n')
    print(json.dumps({'status':'passed','output':str(out),'proofs':len(proofs)}))

if __name__=='__main__':main()
