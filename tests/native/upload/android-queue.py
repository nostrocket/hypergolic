#!/usr/bin/env python3
"""Actual two held approved transfers plus eight SDK/native queued realms and overflow denial."""
import argparse,json,re,time,xml.etree.ElementTree as ET
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
from evidence import ROOT,sha,sources,large_wav,recovery_records
spec=spec_from_file_location('recovery',Path(__file__).with_name('android-recovery.py'));m=module_from_spec(spec);spec.loader.exec_module(m)
class Queue(m.Recovery):
    def first_cancel(self):
        nodes=[n for n in self.nodes() if n.get('resource-id')=='upload-cancel' and self.visible(n)];assert nodes
        x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',nodes[0].get('bounds')).groups());self.report['inputs'].append({'control':'first observed global Cancel upload','bounds':nodes[0].get('bounds')});self.adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
    def run(self):
        build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==self.report['sourceBefore'] and build['productSha256']==sha(self.args.apk.read_bytes())
        installed=self.adb('shell','pm','path',m.PACKAGE).removeprefix('package:');assert sha(self.adb('exec-out','cat',installed,binary=True))==build['productSha256']
        self.report.update(kind='hypergolic-android-upload-queue-v1',productSha256=build['productSha256'],scope='Actual disposable SDK/native two approved exact transfers, eight different queued realms and denied overflow. Controlled private TLS; no protected/public-provider acceptance.')
        self.control(put='hold');baseline=self.observer();self.report['observerBefore']=baseline
        self.adb('shell','am','force-stop',m.PACKAGE);self.adb('shell','pm','clear',m.PACKAGE);self.start()
        # Mount the second host before starting the bounded approved lifetime.
        self.tap('Load Peer Napplet');self.find('Native peer connected')
        self.guest_find('Schedule PNG request in fifteen seconds');self.tap('Schedule PNG request in fifteen seconds')
        self.tap('Switch to Peer Napplet');self.guest_find('Request large WAV upload');self.tap('Request large WAV upload');self.find('Approve file upload');self.tap('Approve once');self.wait_observer('requests',len(baseline['requests'])+1)
        self.tap('Switch to Upload Lab');self.find('Approve file upload');self.tap('Approve once');self.wait_observer('requests',len(baseline['requests'])+2)
        self.find('Active: 2; queued: 0');self.tap('Load eight queue peers');self.find('Active: 2; queued: 8');self.capture('two-active-eight-queued')
        held=self.observer();assert len(held['requests'])==len(baseline['requests'])+2 and len(held['putAttempts'])==len(baseline['putAttempts'])+2
        assert {r['sha256'] for r in held['requests'][-2:]}=={m.HASH,sha(large_wav())} and all(r['signatureVerified'] for r in held['requests'][-2:]);self.check('two exact approved PUTs and eight native accepted SDK queues')
        self.tap('Focus queue peer');self.find('Active: 2; queued: 8');assert not any(n.get('text')=='Approve file upload' for n in self.nodes())
        self.find('Queue pending; second request rejected: quota exceeded');self.check('one pending per actual realm and third review blocked while both slots are active')
        self.tap('Load overflow peer');self.tap('Focus queue peer');self.find('Queue request rejected: quota exceeded');self.find('Active: 2; queued: 8');self.capture('native-overflow-denied')
        assert self.observer()==held;self.check('ninth queued realm denied without TLS or hidden dispatch')
        self.first_cancel();self.find('Active: 1; queued: 8');self.first_cancel();self.find('Active: 0; queued: 8');self.control(put='hold',release=True);time.sleep(2)
        rows=recovery_records(self.adb('exec-out','cat','/data/user/0/'+m.PACKAGE+'/no_backup/UploadRecovery-v1/ledger.bin',binary=True));assert len(rows)==2 and all(r['state']=='unknown' for r in rows)
        self.report['disk']=rows;self.capture('two-cancelled-eight-queued');self.check('both trusted cancels preserve queued work and dispatched uncertainty')
        self.adb('shell','input','keyevent','3');time.sleep(1);self.adb('shell','am','start','-W','-n',m.PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Active: 0; queued: 0')
        self.capture('background-revokes-all-queued');self.check('actual background permanently revokes all eight queued reviews')
        after=self.observer();assert len(after['requests'])==len(held['requests']) and len(after['putAttempts'])==len(held['putAttempts']) and len(after['gets'])==len(baseline['gets']) and not after['errors'];self.report['observerAfter']=after
        self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['status']='passed'
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for n in ['serial','apk','build','observer','output']:p.add_argument('--'+n,required=True,type=str if n=='serial' else Path)
    j=Queue(p.parse_args())
    try:j.run()
    except Exception as e:
        j.report.update(status='failed',error=str(e))
        try:j.capture('failure')
        except Exception:pass
        raise
    finally:j.control(release=True);(j.args.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
