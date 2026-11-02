#!/usr/bin/env python3
"""Selected physical Android HTTPS/WSS TLS and envelope cases under shell UID; no Expo, app lifecycle or complete fault claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
MODULE=ROOT/'modules/napplet-host/android'
KEEPER='org.nostrocket.hypergolic.emptyacceptance'


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    sdk=ROOT/'.tools/android-sdk';tools=sdk/'build-tools/36.0.0';android=sdk/'platforms/android-36/android.jar'
    adb=[str(sdk/'platform-tools/adb'),'-s',args.serial]
    receipt={'status':'failed','scope':__doc__,'remoteCreated':[],'cleanup':[],'runs':[]}
    owned={}
    def run(command,name,cwd=ROOT):
        with (out/(name+'.log')).open('w') as log:
            subprocess.run(command,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
    def device(*values):
        result=subprocess.run([*adb,*values],capture_output=True,text=True,timeout=30)
        receipt['runs'].append({'arguments':list(values),'stdout':result.stdout,'stderr':result.stderr,'exitCode':result.returncode})
        if result.returncode and 'org.nostrocket.hypergolic.host.PhysicalTransportProof' in values:
            rows=result.stdout.splitlines()
            if rows:
                try: pid=json.loads(rows[0]).get('pid')
                except (ValueError,TypeError): pid=None
                if isinstance(pid,int) and pid>0:
                    error=subprocess.run([*adb,'shell','logcat','--pid',str(pid),'-d','-v','brief','-s','AndroidRuntime:E'],capture_output=True,text=True,timeout=30)
                    (out/'owned-proof-runtime-failure.log').write_text(error.stdout+error.stderr)
        result.check_returncode()
        return result.stdout.strip()
    def remote_sha(remote):
        value=device('shell','sha256sum',remote)
        digest=value.split()[0]
        assert re.fullmatch('[0-9a-f]{64}',digest)
        return digest
    try:
        assert device('get-state')=='device'
        assert device('shell','getprop','ro.build.version.sdk')=='36'
        before=device('shell','pm','list','packages','-3').splitlines()
        path=device('shell','pm','path',KEEPER)
        assert path.startswith('package:') and '\n' not in path
        keeper_path=path.removeprefix('package:');keeper_sha=remote_sha(keeper_path)
        receipt.update(inventoryBefore=before,keeperBefore={'path':keeper_path,'sha256':keeper_sha},deviceSerial=args.serial)
        run(['./gradlew',':hypergolic-napplet-host:compileReleaseJavaWithJavac','--offline','--console=plain'],'native-compile',ROOT/'android')
        class_dirs=[MODULE/'build/tmp/kotlin-classes/release',MODULE/'build/intermediates/javac/release/compileReleaseJavaWithJavac/classes']
        compiled={str(p.relative_to(ROOT)):sha(p) for folder in class_dirs for p in folder.rglob('*.class')}
        receipt['compiledInputs']=compiled
        cache=ROOT/'.tools/gradle-home/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.1.20'
        jars=list(cache.glob('*/*.jar'));assert len(jars)==1
        stdlib=jars[0]
        proof_sources=[HERE/'PhysicalTransportProof.java',ROOT/'tests/native/android-published-https/PublishedHttpsTlsProof.java',ROOT/'tests/native/android-published-wss/PublishedRelayWssTlsProof.java',ROOT/'tests/native/android-published-wss/PublishedRelayResponseClassifierProof.java']
        selected=[*proof_sources,Path(__file__),android,stdlib]
        selected += list((MODULE/'src/main/java/org/nostrocket/hypergolic/host').glob('*.java'))
        selected += list((MODULE/'src/main/java/org/nostrocket/hypergolic/host').glob('*.kt'))
        receipt['sourceBefore']={str(p.relative_to(ROOT)):sha(p) for p in selected}
        classes=out/'classes';classes.mkdir()
        classpath=os.pathsep.join(map(str,[*class_dirs,stdlib,android]))
        run(['javac','--release','17','-Xlint:all','-Werror','-cp',classpath,'-d',str(classes),*map(str,proof_sources)],'proof-compile')
        combined=out/'native-input.jar'
        run(['jar','cf',str(combined),'-C',str(classes),'.',*[item for folder in class_dirs for item in ['-C',str(folder),'.']]],'jar')
        dex=out/'dex';dex.mkdir()
        run([str(tools/'d8'),'--min-api','36','--lib',str(android),'--output',str(dex),str(combined),str(stdlib)],'dex')
        jar=out/'physical-transport-proof.jar'
        run(['jar','cf',str(jar),'-C',str(dex),'.'],'dex-jar')
        for index,p in enumerate(sorted(dex.glob('*.dex'))):
            run([str(tools/'dexdump'),'-f',str(p)],'dex-inventory-'+str(index))
            text=(out/('dex-inventory-'+str(index)+'.log')).read_text()
            assert not re.search(r"Class descriptor\s*:\s*'Lorg/json/",text),'Packaged JSON would replace framework proof'
        receipt['product']={'jarSha256':sha(jar),'nativeInputJarSha256':sha(combined),'dex':{p.name:sha(p) for p in dex.glob('*.dex')}}
        suffix=uuid.uuid4().hex
        local_files=[jar]
        for label,host in [('https','napplets.example.org'),('wss','relay.example.org')]:
            key=out/(label+'.key');cert=out/(label+'.pem');bundle=out/(label+'.p12')
            try:
                run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),'-subj','/CN='+host,'-addext','subjectAltName=DNS:'+host,'-addext','extendedKeyUsage=serverAuth','-addext','keyUsage=digitalSignature,keyEncipherment'],label+'-certificate')
                run(['openssl','pkcs12','-export','-inkey',str(key),'-in',str(cert),'-out',str(bundle),'-passout','pass:temporary-proof'],label+'-identity')
            finally:
                key.unlink(missing_ok=True)
            local_files += [cert,bundle]
        remote_files=[]
        for local in local_files:
            remote='/data/local/tmp/hg-transport-'+suffix+'-'+local.name
            test=subprocess.run([*adb,'shell','test','-e',remote],capture_output=True,text=True,timeout=30)
            assert test.returncode==1,'Refuse replacing existing remote file'
            owned[remote]=sha(local);receipt['remoteCreated'].append({'path':remote,'sha256':owned[remote]})
            device('push',str(local),remote)
            assert remote_sha(remote)==owned[remote]
            remote_files.append(remote)
        result=device('shell','env','CLASSPATH='+remote_files[0],'app_process','/system/bin','org.nostrocket.hypergolic.host.PhysicalTransportProof',*remote_files[1:])
        (out/'physical-proof.log').write_text(result+'\n')
        rows=result.splitlines()
        runtime=json.loads(rows[0])
        assert len(rows)==4 and runtime['sdk']==36 and runtime['uid']==2000
        expected={'PublishedHttpsTlsProof':55,'PublishedRelayWssTlsProof':37,'PublishedRelayResponseClassifierProof':23}
        for line,(name,count) in zip(rows[1:],expected.items()):
            assert line==f'{name}: {count} checks passed',line
        receipt['proof']={'runtime':runtime,'checks':expected,'totalAssertions':sum(expected.values())}
        assert all(sha(ROOT/path)==value for path,value in receipt['sourceBefore'].items())
        assert all(sha(ROOT/path)==value for path,value in compiled.items())
        receipt['sourceAfter']=receipt['sourceBefore'].copy()
        receipt['status']='passed-scoped-physical-native-transport'
    except Exception as error:
        receipt['error']=str(error)
        raise
    finally:
        for remote,digest in owned.items():
            try:
                assert remote_sha(remote)==digest,'Refuse removing changed remote file'
                device('shell','rm',remote)
                absent=subprocess.run([*adb,'shell','test','-e',remote],capture_output=True,text=True,timeout=30)
                assert absent.returncode==1
                receipt['cleanup'].append({'path':remote,'sha256':digest,'absent':True})
            except Exception as error:
                receipt['status']='failed-cleanup';receipt['cleanup'].append({'path':remote,'error':str(error)})
        if 'keeperBefore' in receipt:
            try:
                after=device('shell','pm','list','packages','-3').splitlines()
                keeper_path=device('shell','pm','path',KEEPER).removeprefix('package:')
                receipt['inventoryAfter']=after;receipt['keeperAfter']={'path':keeper_path,'sha256':remote_sha(keeper_path)}
                assert after==receipt['inventoryBefore'] and receipt['keeperAfter']==receipt['keeperBefore']
            except Exception as error:
                receipt['status']='failed-cleanup';receipt['keeperVerificationError']=str(error)
        for name in ['https.key','wss.key','https.p12','wss.p12']:
            (out/name).unlink(missing_ok=True)
        receipt['ephemeralIdentitiesRemoved']=all(not (out/name).exists() for name in ['https.key','wss.key','https.p12','wss.p12'])
        receipt['logs']={p.name:sha(p) for p in out.glob('*.log')}
        (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    if receipt['status']!='passed-scoped-physical-native-transport':raise SystemExit(1)
    print(json.dumps({'status':receipt['status'],'proof':receipt['proof'],'cleanup':receipt['cleanup']}))


if __name__=='__main__':main()
