#!/usr/bin/env python3
"""Disposable physical Android shell-UID plan/ACK proof; no app UI, signing or guest composition claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]
MODULE=ROOT/'modules/napplet-host/android'
KEEPER='org.nostrocket.hypergolic.emptyacceptance'


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--ack-grammar',action='store_true',help='Run only the focused ACK grammar regression on framework JSON')
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
        if result.returncode and 'org.nostrocket.hypergolic.host.DevicePlanProof' in values:
            rows=result.stdout.splitlines()
            if rows:
                pid=json.loads(rows[0]).get('pid')
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
        selected=[HERE/'PlanProof.java',HERE/'DevicePlanProof.java',Path(__file__),HERE/'fixtures.json',android,stdlib]
        selected += list((MODULE/'src/main/java/org/nostrocket/hypergolic/host').glob('*.java'))
        selected += list((MODULE/'src/main/java/org/nostrocket/hypergolic/host').glob('*.kt'))
        receipt['sourceBefore']={str(p.relative_to(ROOT)):sha(p) for p in selected}
        classes=out/'classes';classes.mkdir()
        classpath=os.pathsep.join(map(str,[*class_dirs,stdlib,android]))
        run(['javac','--release','17','-Xlint:all','-Werror','-cp',classpath,'-d',str(classes),str(HERE/'PlanProof.java'),str(HERE/'DevicePlanProof.java')],'proof-compile')
        combined=out/'native-input.jar'
        run(['jar','cf',str(combined),'-C',str(classes),'.',*[item for folder in class_dirs for item in ['-C',str(folder),'.']]],'jar')
        dex=out/'dex';dex.mkdir()
        run([str(tools/'d8'),'--min-api','36','--lib',str(android),'--output',str(dex),str(combined),str(stdlib)],'dex')
        jar=out/'device-plan-proof.jar'
        run(['jar','cf',str(jar),'-C',str(dex),'.'],'dex-jar')
        for index,p in enumerate(sorted(dex.glob('*.dex'))):
            run([str(tools/'dexdump'),'-f',str(p)],'dex-inventory-'+str(index))
            text=(out/('dex-inventory-'+str(index)+'.log')).read_text()
            assert not re.search(r"Class descriptor\s*:\s*'Lorg/json/",text),'Packaged JSON would replace framework proof'
        receipt['product']={'jarSha256':sha(jar),'nativeInputJarSha256':sha(combined),'dex':{p.name:sha(p) for p in dex.glob('*.dex')}}
        suffix=uuid.uuid4().hex
        for local,extension in [(jar,'jar'),(HERE/'fixtures.json','json')]:
            remote='/data/local/tmp/hg-outbox-plan-'+suffix+'.'+extension
            test=subprocess.run([*adb,'shell','test','-e',remote],capture_output=True,text=True,timeout=30)
            assert test.returncode==1,'Refuse replacing existing remote file'
            owned[remote]=sha(local);receipt['remoteCreated'].append({'path':remote,'sha256':owned[remote]})
            device('push',str(local),remote)
            assert remote_sha(remote)==owned[remote]
        jar_remote=next(path for path in owned if path.endswith('.jar'))
        fixture_remote=next(path for path in owned if path.endswith('.json'))
        extra=['--ack-grammar'] if args.ack_grammar else []
        result=device('shell','env','CLASSPATH='+jar_remote,'app_process','/system/bin','org.nostrocket.hypergolic.host.DevicePlanProof',fixture_remote,*extra)
        (out/'physical-proof.log').write_text(result+'\n')
        rows=[json.loads(line) for line in result.splitlines()]
        assert len(rows)==2 and rows[0]['frameworkJson'] is True and rows[0]['sdk']==36 and rows[0]['uid']==2000
        assert rows[1]['status']=='passed' and rows[1]['assertions']==(37 if args.ack_grammar else 106)
        receipt['proof']=rows
        assert all(sha(ROOT/path)==value for path,value in receipt['sourceBefore'].items())
        assert all(sha(ROOT/path)==value for path,value in compiled.items())
        receipt['sourceAfter']=receipt['sourceBefore'].copy()
        receipt['status']='passed-scoped-physical-native-core'
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
        receipt['logs']={p.name:sha(p) for p in out.glob('*.log')}
        (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    if receipt['status']!='passed-scoped-physical-native-core':raise SystemExit(1)
    print(json.dumps({'status':receipt['status'],'proof':receipt['proof'],'cleanup':receipt['cleanup']}))


if __name__=='__main__':main()
