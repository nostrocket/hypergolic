#!/usr/bin/env python3
"""Build a transparent emulator-side bandwidth hop so ADB cannot buffer an entire PUT."""
import argparse,hashlib,json,subprocess
from pathlib import Path
from evidence import ROOT
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();assert a.serial.startswith('emulator-');a.output.mkdir(exist_ok=False)
sdk=ROOT/'.tools/android-sdk';platform=sdk/'platforms/android-36';tools=sdk/'build-tools/36.0.0';classes=a.output/'classes';classes.mkdir();dex=a.output/'dex';dex.mkdir()
subprocess.run(['javac','--release','11','-classpath',str(platform/'android.jar'),'-d',str(classes),str(ROOT/'tests/native/upload/BackpressureProxy.java')],check=True)
archive=a.output/'classes.jar';subprocess.run(['jar','cf',str(archive),'-C',str(classes),'.'],check=True)
subprocess.run([str(tools/'d8'),'--min-api','26','--lib',str(platform/'android.jar'),'--output',str(dex),str(archive)],check=True)
bytecode=dex/'classes.dex';adb=[str(sdk/'platform-tools/adb'),'-s',a.serial];subprocess.run(adb+['push',str(bytecode),'/data/local/tmp/hg-upload-proxy.dex'],check=True)
subprocess.run(adb+['reverse','--remove','tcp:19943'],check=True);subprocess.run(adb+['reverse','tcp:29943','tcp:19943'],check=True)
(a.output/'result.json').write_text(json.dumps({'status':'built','scope':'Transparent Android shell-UID TCP hop; exact end-to-end TLS and independently observed HTTP remain mandatory','dexSha256':hashlib.sha256(bytecode.read_bytes()).hexdigest(),'forward':'native 127.0.0.1:19943 -> proxy -> ADB 127.0.0.1:29943 -> host 127.0.0.1:19943','millisecondsPer8192Bytes':40},indent=2)+'\n')
print('BUILT transparent TCP hop; start the explicit app_process command separately',flush=True)
