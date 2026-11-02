#!/usr/bin/env python3
"""Actual Android handoff controller/source/RPC, with explicitly labeled native UI/owner/TLS ports."""
import argparse, hashlib, json, os, shutil, subprocess, time, zipfile
from pathlib import Path
from urllib.parse import urlparse
ROOT = Path(__file__).resolve().parents[5]
HERE = Path(__file__).resolve().parent
PACKAGE = 'org.nostrocket.hypergolic.signercore.handoffproof'

def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True,type=Path);parser.add_argument('--serial',required=True)
    args=parser.parse_args()
    if not args.serial.startswith('emulator-'):raise RuntimeError('Disposable emulator required')
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    sdk=ROOT/'.tools/android-sdk';java=ROOT/'.tools/jdk/Contents/Home/bin';node=ROOT/'.tools/node/bin/node'
    build=sdk/'build-tools/36.0.0';platform=sdk/'platforms/android-36/android.jar'
    env=os.environ.copy();env['JAVA_HOME']=str(java.parent);env['PATH']=str(java)+os.pathsep+env['PATH']
    commands=[]
    def run(command,timeout=120,allow_failure=False):
        r=subprocess.run([str(x) for x in command],env=env,capture_output=True,text=True,timeout=timeout)
        commands.append({'command':[str(x) for x in command],'exitCode':r.returncode,'output':r.stdout+r.stderr})
        (out/'commands.json').write_text(json.dumps(commands,indent=2)+'\n')
        if r.returncode and not allow_failure:raise RuntimeError('Command failed; inspect commands.json')
        return r.stdout
    def adb(*command,**options):return run([sdk/'platform-tools/adb','-s',args.serial,*command],timeout=30,**options)
    def inventory():return sorted(adb('shell','pm','list','packages').splitlines())
    bound=set(p for p in HERE.rglob('*') if p.is_file())
    for folder in ['modules/signer-core/android/src/main','modules/signer-core/shared','modules/signer-core/vendor','modules/napplet-host/android/src/main/java','tests/native/signer-core/nip46']:
        bound.update(p for p in (ROOT/folder).rglob('*') if p.is_file())
    before={str(p.relative_to(ROOT)):digest(p) for p in sorted(bound)}
    (out/'source-before.json').write_text(json.dumps(before,indent=2)+'\n')
    for name,expected in before.items():
        target=out/'source-snapshot'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
        if digest(target)!=expected:raise RuntimeError('Snapshot changed')
    def verify():
        after={name:digest(ROOT/name) for name in before}
        if after!=before:raise RuntimeError('Source changed during owning trace')
        return after
    for name in ['secp256k1','monocypher']:
        pin=json.loads((ROOT/f'modules/signer-core/vendor/{name}-manifest.json').read_text())
        for relative,expected in pin['files'].items():
            if digest(ROOT/'modules/signer-core/vendor'/name/relative)!=expected:raise RuntimeError('Crypto pin differs')
    receipt={'status':'failed','sourceBefore':before,'scope':'Actual controller/source/client, native owner/browser/gesture/lock event and loopback DNS/trust ports are explicit doubles. No production Expo or external browser acceptance.'}
    installed=False;ports=[];original=None
    serverlog=(out/'peer.log').open('w')
    server=subprocess.Popen([str(node),str(ROOT/'tests/native/signer-core/nip46/server.mjs'),'--output',str(out/'peer'),'--fixture-keys','public-vectors'],cwd=ROOT,env=env,stdout=serverlog,stderr=serverlog)
    try:
        until=time.monotonic()+15
        while not (out/'peer/ready.json').exists():
            if server.poll() is not None or time.monotonic()>until:raise RuntimeError('Controlled peer did not start')
            time.sleep(.1)
        ready=json.loads((out/'peer/ready.json').read_text())
        native=out/'native';cmake=sdk/'cmake/3.22.1/bin/cmake'
        run([cmake,'-S',ROOT/'modules/signer-core/android/src/main/cpp','-B',native,'-G','Ninja','-DCMAKE_TOOLCHAIN_FILE='+str(sdk/'ndk/27.1.12297006/build/cmake/android.toolchain.cmake'),'-DCMAKE_MAKE_PROGRAM='+str(sdk/'cmake/3.22.1/bin/ninja'),'-DANDROID_ABI=arm64-v8a','-DANDROID_PLATFORM=android-26','-DANDROID_STL=c++_static','-DCMAKE_BUILD_TYPE=Release'])
        run([cmake,'--build',native])
        libraries=[]
        for module in ['signer-core','napplet-host']:
            target=out/(module+'.jar')
            javaClasses=ROOT/f'modules/{module}/android/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes'
            kotlinClasses=ROOT/f'modules/{module}/android/build/tmp/kotlin-classes/debug'
            run([java/'jar','cf',target,'-C',javaClasses,'.','-C',kotlinClasses,'.']);libraries.append(target)
        cache=ROOT/'.tools/gradle-home/caches/modules-2/files-2.1'
        def cached(group,name,version):return next((cache/group/name/version).glob('*/*.jar'))
        stdlib=cached('org.jetbrains.kotlin','kotlin-stdlib','2.1.20')
        coroutines=cached('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.10.2')
        androidCoroutines=cached('org.jetbrains.kotlinx','kotlinx-coroutines-android','1.10.2')
        expo=next((ROOT/'node_modules/.pnpm').glob('expo-modules-core@*/node_modules/expo-modules-core/android/build/intermediates/compile_library_classes_jar/debug/bundleLibCompileToJarDebug/classes.jar'))
        libraries += [stdlib,coroutines,androidCoroutines]
        classpath=os.pathsep.join(map(str,[platform,expo,*libraries]))
        classes=out/'classes'
        run([java/'javac','--release','17','-cp',classpath,'-d',classes,HERE/'HandoffSourceFixture.java',HERE/'HandoffFixtureSource.java',HERE/'FixtureHandoffCancellationProof.java',ROOT/'tests/native/signer-core/nip46/android/NativeSignerRelayFixture.java'])
        compiler=cached('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20')
        compilerDeps=[compiler,stdlib,cached('org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'),cached('org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'),coroutines]
        compilerDeps += list((cache/'org.jetbrains.intellij.deps/trove4j').glob('*/*/*.jar'))
        compilerDeps += list((cache/'org.jetbrains/annotations').glob('*/*/*.jar'))
        run([java/'java','-cp',os.pathsep.join(map(str,compilerDeps)),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',classpath+os.pathsep+str(classes),'-Xfriend-paths='+str(libraries[0]),'-d',classes,HERE/'HandoffOwningActivity.kt'])
        jar=out/'tests.jar';run([java/'jar','cf',jar,'-C',classes,'.'])
        dex=out/'dex';dex.mkdir();run([build/'d8','--min-api','36','--lib',platform,'--output',dex,jar,*libraries])
        manifest=out/'AndroidManifest.xml';manifest.write_text(f'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{PACKAGE}"><uses-sdk android:minSdkVersion="36" android:targetSdkVersion="36"/><uses-permission android:name="android.permission.INTERNET"/><application android:debuggable="true" android:allowBackup="false" android:usesCleartextTraffic="true" android:extractNativeLibs="true" android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name="org.nostrocket.hypergolic.signercore.HandoffOwningActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>')
        unsigned=out/'unsigned.apk';run([build/'aapt2','link','-I',platform,'--manifest',manifest,'-o',unsigned])
        with zipfile.ZipFile(unsigned,'a',zipfile.ZIP_DEFLATED) as archive:
            for path in dex.glob('*.dex'):archive.write(path,path.name)
            archive.write(native/'libhypergolic_signer_jni.so','lib/arm64-v8a/libhypergolic_signer_jni.so')
            archive.writestr('assets/fixture.json',json.dumps(ready));archive.write(ready['der'],'assets/fixture.der')
            for p in (ROOT/'modules/signer-core/android/src/main/assets/notices').glob('*.txt'):archive.write(p,'assets/notices/'+p.name)
        aligned=out/'aligned.apk';run([build/'zipalign','-f','4',unsigned,aligned]);key=out/'disposable.jks'
        run([java/'keytool','-genkeypair','-keystore',key,'-storepass','disposable-test','-keypass','disposable-test','-alias','proof','-dname','CN=Disposable handoff owning proof','-keyalg','RSA','-validity','2','-noprompt'])
        apk=out/'proof.apk';run([build/'apksigner','sign','--ks',key,'--ks-pass','pass:disposable-test','--key-pass','pass:disposable-test','--out',apk,aligned]);run([build/'apksigner','verify',apk]);verify()
        receipt['compiledInputs']={p.name:digest(p) for p in [jar,*libraries,expo]}
        original=inventory();(out/'inventory-before.json').write_text(json.dumps(original,indent=2)+'\n')
        if 'package:'+PACKAGE in original:raise RuntimeError('Owned package already exists')
        reverse=adb('reverse','--list')
        for port in [ready['port'],urlparse(ready['controlURL']).port]:
            if 'tcp:'+str(port) in reverse:raise RuntimeError('Fixture port in use')
            adb('reverse','tcp:'+str(port),'tcp:'+str(port));ports.append(port)
        installed=True;adb('install',apk);adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.signercore.HandoffOwningActivity')
        until=time.monotonic()+45;result=None
        while time.monotonic()<until:
            raw=adb('exec-out','run-as',PACKAGE,'cat','files/result.json',allow_failure=True)
            if raw.strip().startswith('{'):
                result=json.loads(raw);(out/'native-result.json').write_text(json.dumps(result,indent=2)+'\n');break
            time.sleep(.2)
        if not result or result['status']!='passed' or result['assertions']<20 or len(result['cases'])!=6:raise RuntimeError('Owning controller/client incomplete or failed')
        receipt.update(status='passed',native=result,sourceAfter=verify(),apkSha256=digest(apk))
    finally:
        if installed:adb('uninstall',PACKAGE,allow_failure=True)
        for port in ports:adb('reverse','--remove','tcp:'+str(port),allow_failure=True)
        if original is not None:
            final=inventory();(out/'inventory-after.json').write_text(json.dumps(final,indent=2)+'\n')
            receipt['cleanup']='Owned proof absent; exact inventory restored.' if original==final else 'Inventory mismatch'
            if final!=original:receipt['status']='failed'
        server.terminate()
        try:server.wait(timeout=5)
        except subprocess.TimeoutExpired:server.kill();server.wait()
        serverlog.close()
        if (out/'peer/receipt.json').exists():shutil.copyfile(out/'peer/receipt.json',out/'peer-receipt.json')
        (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    if receipt['status']!='passed':raise RuntimeError('Owning handoff trace failed')
    print(json.dumps({'status':'passed','assertions':receipt['native']['assertions'],'output':str(out)}))
if __name__=='__main__':main()
