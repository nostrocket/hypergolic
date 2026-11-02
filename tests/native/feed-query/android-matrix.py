#!/usr/bin/env python3
"""Native SDK/lease query faults with diagnostic frames, not a live WSS fault test."""
import argparse
import importlib.util
import json
from pathlib import Path

spec=importlib.util.spec_from_file_location('query_driver',Path(__file__).with_name('android-query.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
CASES=['signed','empty','bad-signature','wrong-filter','missing-eose','event-flood','frame-flood','timeout','close','owner-epoch']
class Matrix(base.Journey):
    def run(self):
        self.result.update(kind='hypergolic-android-query-fault-matrix-v1',scope=__doc__)
        installed=self.adb('shell','pm','path',base.PACKAGE).splitlines();assert len(installed)==1
        actual=self.adb('exec-out','cat',installed[0].removeprefix('package:'),binary=True)
        assert base.digest(actual)==base.digest(self.args.apk.read_bytes())
        self.result['installedApkSha256']=base.digest(actual)
        self.adb('shell','am','force-stop',base.PACKAGE)
        self.adb('shell','am','start','-W','-n',base.PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
        self.tap(self.find('Controlled query faults'))
        for name in CASES:
            self.find('Controlled query · '+name);self.find('Ready to query.');self.tap(self.find('Query notes'))
            delayed=name in ('timeout','close','owner-epoch');revoked=name in ('close','owner-epoch')
            self.find(f'PASS {name}: calls 1, cancel {int(delayed)}, late {int(delayed)}, replies {int(not revoked)}, denied {int(revoked)}')
            if name=='signed':
                self.find('Received 1 signed note.');self.find('Native query acceptance fixture')
            elif name=='empty':self.find('Query completed. No matching notes.')
            elif not revoked:
                self.find('Query failed: relay query failed')
                assert not any(n.get('text')=='Native query acceptance fixture' for n in self.nodes())
            if name=='close':assert not any(n.get('class')=='android.webkit.WebView' for n in self.nodes())
            if name=='owner-epoch':
                self.find('Query failed: operation failed')
                assert not any(n.get('text')=='Native query acceptance fixture' for n in self.nodes())
            self.capture('query-matrix-'+name);self.check(name)
            if name!=CASES[-1]:self.tap(self.find('Next query case'))
        self.result['sourceAfter']=base.sources();assert self.result['sourceBefore']==self.result['sourceAfter']
        self.result['status']='passed'
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial',required=True);parser.add_argument('--adb',default=str(base.ROOT/'.tools/android-sdk/platform-tools/adb'))
    parser.add_argument('--apk',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    journey=Matrix(parser.parse_args())
    try:journey.run()
    except Exception as error:journey.result.update(status='failed',error=str(error));raise
    finally:(journey.out/'result.json').write_text(json.dumps(journey.result,indent=2)+'\n')
