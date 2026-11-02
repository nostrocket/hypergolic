#!/usr/bin/env python3
"""Build an observation-only native AX helper; no app installation or lifecycle acceptance."""
import argparse,hashlib,json,subprocess,time
from pathlib import Path
from evidence import ROOT
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.mkdir(exist_ok=False)
sdk=ROOT/'.tools/android-sdk';platform=sdk/'platforms/android-36';tools=sdk/'build-tools/36.0.0';classes=a.output/'classes';classes.mkdir();dex=a.output/'dex';dex.mkdir();source=ROOT/'tests/native/presentation/NotifyUiDump.java'
classpath=':'.join(str(platform/n) for n in ['android.jar','uiautomator.jar','optional/android.test.base.jar'])
subprocess.run(['javac','--release','8','-classpath',classpath,'-d',str(classes),str(source)],check=True)
archive=a.output/'classes.jar';subprocess.run(['jar','cf',str(archive),'-C',str(classes),'.'],check=True)
subprocess.run([str(tools/'d8'),'--min-api','26','--lib',str(platform/'android.jar'),'--classpath',str(platform/'uiautomator.jar'),'--classpath',str(platform/'optional/android.test.base.jar'),'--output',str(dex),str(archive)],check=True)
jar=a.output/'ui-dump.jar';subprocess.run(['jar','cf',str(jar),'-C',str(dex),'classes.dex'],check=True)
adb=[str(sdk/'platform-tools/adb'),'-s',a.serial];remote='/data/local/tmp/hg-notify-uia.jar';digest=lambda b:hashlib.sha256(b).hexdigest();product=digest(jar.read_bytes())
existing=subprocess.run(adb+['shell','test','-e',remote],capture_output=True)
assert existing.returncode in [0,1],'Observer path absence could not be confirmed'
if existing.returncode==0:assert digest(subprocess.check_output(adb+['exec-out','cat',remote]))==product,'Refuse replacing an unknown observer jar'
else:subprocess.run(adb+['push',str(jar),remote],check=True)
assert digest(subprocess.check_output(adb+['exec-out','cat',remote]))==product
subprocess.run(adb+['shell','rm','-f','/data/local/tmp/hg-notify.xml'],check=True)
start=time.monotonic();r=subprocess.run(adb+['shell','CLASSPATH=/system/framework/android.test.base.jar:/system/framework/android.test.runner.jar:/system/framework/uiautomator.jar:'+remote,'app_process','/system/bin','com.android.commands.uiautomator.Launcher','runtest','-c','org.nostrocket.hypergolic.proof.NotifyUiDump','-e','jars',remote],check=True,capture_output=True,text=True);(a.output/'probe.log').write_text(r.stdout+r.stderr)
assert 'aborted' not in r.stdout and 'INSTRUMENTATION_STATUS_CODE: 0' in r.stdout and 'OK (1 test)' in r.stdout
xml=subprocess.check_output(adb+['exec-out','cat','/data/local/tmp/hg-notify.xml']);assert b'<hierarchy' in xml and b'org.nostrocket.hypergolic.emptyacceptance' in xml;(a.output/'probe.xml').write_bytes(xml)
(a.output/'result.json').write_text(json.dumps({'status':'passed-native-observer-probe','scope':'Observation-only shell UID helper; no APK installation, privilege bypass, application lifecycle or notification acceptance','sourceSha256':digest(source.read_bytes()),'jarSha256':product,'remoteJar':remote,'durationSeconds':time.monotonic()-start,'output':r.stdout},indent=2)+'\n');print(r.stdout,flush=True)
