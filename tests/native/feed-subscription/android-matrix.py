#!/usr/bin/env python3
"""SDK/native stream fault matrix with diagnostic frame input, not WSS network faults."""
import argparse
import importlib.util
import json
from pathlib import Path
spec=importlib.util.spec_from_file_location('stream_journey',Path(__file__).with_name('android-stream.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
CASES=['signed-live','duplicate','bad-signature','wrong-filter','foreign-sub','frame-flood','oversized-frame','view-revoke','paused-owner-revoke']
class Matrix(module.Journey):
    def run(self):
        self.report['kind']='hypergolic-android-stream-fault-matrix-v1'
        self.report['scope']='Genuine SDK/Kehto/native immutable admission and captured delivery, production validators; diagnostic frames and public owner revocation. No real WSS fault or protected identity UI claim.'
        installed=self.adb('shell','pm','path',module.PACKAGE).removeprefix('package:');actual=self.adb('exec-out','cat',installed,binary=True)
        assert module.digest(actual)==module.digest(self.args.apk.read_bytes());self.report['installedApkSha256']=module.digest(actual)
        self.adb('shell','am','force-stop',module.PACKAGE);self.launch();self.button('Controlled stream faults')
        for name in CASES:
            self.find('Controlled stream · '+name);self.find('Start live feed');self.button('Start live feed')
            positive=name in ['signed-live','duplicate'];revoked=name in ['view-revoke','paused-owner-revoke']
            receipt=f'PASS {name}: calls 1, cancel {0 if positive else 1}, late {1 if revoked else 0}, events {2 if name=="signed-live" else 1 if name=="duplicate" else 0}, EOSE {1 if positive else 0}, closed {0 if positive or revoked else 1}'
            self.find(receipt)
            if positive:self.live(2 if name=='signed-live' else 1)
            elif not revoked:self.find('Live feed closed: invalid or excessive relay stream')
            if name=='view-revoke':assert not any(n.get('class')=='android.webkit.WebView' for n in self.nodes())
            if not positive:assert not any(n.get('text')=='Native query acceptance fixture' for n in self.nodes())
            self.check(name);self.capture('stream-matrix-'+name)
            if name!=CASES[-1]:self.button('Next stream case')
        self.report['sourceAfter']=module.sources();assert self.report['sourceBefore']==self.report['sourceAfter'];self.report['status']='passed'
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--serial',required=True);parser.add_argument('--adb',default=str(module.ROOT/'.tools/android-sdk/platform-tools/adb'));parser.add_argument('--apk',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    journey=Matrix(parser.parse_args())
    try:journey.run()
    except Exception as error:journey.report.update(status='failed',error=str(error));raise
    finally:(journey.out/'result.json').write_text(json.dumps(journey.report,indent=2)+'\n')
