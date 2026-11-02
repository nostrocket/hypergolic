#!/usr/bin/env python3
"""Actual Android codecs under shell UID; not SDK/picker/native UI acceptance."""
import argparse,hashlib,json,subprocess,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];HOST=ROOT/'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--fixtures',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
assert a.serial.startswith('emulator-');sdk=ROOT/'.tools/android-sdk';adb=str(sdk/'platform-tools/adb');remote='/data/local/tmp/hg-photo-'+uuid.uuid4().hex
sources=[HOST/(name+'.java') for name in ['NativeSigningHold','NativeUploadAuthority','UploadFileProfile','UploadPngProfile','UploadPngMetadata','UploadExifMetadata','UploadPhotoContainer','UploadPhotoPreparation']]+[Path(__file__).with_name('UploadPhotoDeviceProof.java')]
sha=lambda b:hashlib.sha256(b).hexdigest()
report={'status':'running','scope':__doc__,'sourceBefore':{str(f.relative_to(ROOT)):sha(f.read_bytes()) for f in sources}}
def run(*cmd):return subprocess.check_output(cmd,cwd=ROOT,stderr=subprocess.STDOUT,text=True)
try:
 api=int(run(adb,'-s',a.serial,'shell','getprop','ro.build.version.sdk'));assert api>=34
 report['device']={'serial':a.serial,'api':api,'fingerprint':run(adb,'-s',a.serial,'shell','getprop','ro.build.fingerprint').strip()}
 classes=a.output/'classes';classes.mkdir();dex=a.output/'dex';dex.mkdir();android=sdk/'platforms/android-36/android.jar'
 run('javac','--release','17','-Xlint:all','-Werror','-classpath',str(android),'-d',str(classes),*(str(f) for f in sources))
 jar=a.output/'proof.jar';run('jar','cf',str(jar),'-C',str(classes),'.');run(str(sdk/'cmdline-tools/23.0/bin/d8'),'--min-api',str(api),'--lib',str(android),'--output',str(dex),str(jar))
 report['dexSha256']=sha((dex/'classes.dex').read_bytes());run(adb,'-s',a.serial,'shell','mkdir','-p',remote)
 run(adb,'-s',a.serial,'push',str(dex/'classes.dex'),remote+'/proof.dex');run(adb,'-s',a.serial,'push',str(a.fixtures),remote+'/fixtures');run(adb,'-s',a.serial,'shell','chmod','444',remote+'/proof.dex')
 result=run(adb,'-s',a.serial,'shell','CLASSPATH='+remote+'/proof.dex','app_process','/system/bin','org.nostrocket.hypergolic.host.UploadPhotoDeviceProof',remote+'/fixtures',remote+'/output')
 report['stdout']=result;manifest=json.loads((a.fixtures/'photos.json').read_text());expected=2*len(manifest['files'])+len(manifest['invalid']);assert result.strip().splitlines()[-1]==f'UploadPhotoDeviceProof: {expected} checks passed',result
 run(adb,'-s',a.serial,'pull',remote+'/output',str(a.output/'prepared'))
 report['sourceAfter']={str(f.relative_to(ROOT)):sha(f.read_bytes()) for f in sources};assert report['sourceAfter']==report['sourceBefore'];report['status']='passed';print(result)
except Exception as error:
 report.update(status='failed',error=str(error),diagnostic=getattr(error,'output',None));print(getattr(error,'output',''));raise
finally:
 run(adb,'-s',a.serial,'shell','rm','-rf',remote);(a.output/'result.json').write_text(json.dumps(report,indent=2)+'\n')
