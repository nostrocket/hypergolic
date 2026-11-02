#!/usr/bin/env python3
"""Real SDK/native provider failures, transfer stop and metadata-store denial witnesses."""
import argparse,json,subprocess,time,hashlib
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
from evidence import large_wav,ROOT,sha,sources
spec=spec_from_file_location('recovery',Path(__file__).with_name('android-recovery.py'));m=module_from_spec(spec);spec.loader.exec_module(m)
PACKAGE=m.PACKAGE;HASH=m.HASH
class Matrix(m.Recovery):
    def reset(self,mode):
        self.control(put=mode);self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','pm','clear',PACKAGE);self.start()
    def row(self,name,state):
        rows=self.disk(name);assert len(rows)==1 and rows[0]['state']==state,(name,rows);return rows[0]
    def same_puts(self,before,count=1,stored=None):
        after=self.observer();assert len(after['putAttempts'])==len(before['putAttempts'])+count
        if stored is not None:assert len(after['requests'])==len(before['requests'])+stored
        assert len(after['gets'])==len(before['gets']);assert not after['errors'];return after
    def reject_fault(self,mode,state,stored):
        self.reset(mode);before=self.observer();self.review();self.tap('Approve once');self.find('Upload failed.',timeout=75);self.capture(mode+'-failed')
        self.row(mode,state);after=self.same_puts(before,stored=stored)
        assert after['putAttempts'][-1]['signatureVerified'] and after['putAttempts'][-1]['sha256']==HASH
        assert not any(n.get('text')=='Upload complete.' for n in self.nodes());self.check(mode+': exact attempt, '+state+', no retry/read/success')
    def interrupted(self,action):
        self.reset('before-tls' if action=='before-body' else 'slow-stream' if action=='stream' else 'hold');before=self.observer()
        if action=='stream':
            self.guest_find('Request large WAV upload');self.tap('Request large WAV upload');self.find('Approve file upload');self.find('Approve once')
        else:self.review()
        self.tap('Approve once');self.find('Cancel upload')
        if action=='before-body':
            deadline=time.monotonic()+10
            while self.observer()['connections']==before['connections'] and time.monotonic()<deadline:time.sleep(.1)
            assert self.observer()['connections']==before['connections']+1 and self.observer()['putAttempts']==before['putAttempts']
        elif action=='stream':self.wait_observer('putAttempts',len(before['putAttempts'])+1)
        else:self.wait_observer('requests',len(before['requests'])+1)
        (self.args.output/(action+'-held.xml')).write_bytes(self.xml)
        (self.args.output/(action+'-held.png')).write_bytes(self.adb('exec-out','screencap','-p',binary=True))
        if action=='background':
            old=self.adb('shell','pidof',PACKAGE);self.adb('shell','input','keyevent','3');time.sleep(1);self.control(put='hold',release=True);time.sleep(1)
            self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');assert self.adb('shell','pidof',PACKAGE)==old
        elif action=='close':self.tap('Close Upload Lab');self.find('Upload Lab closed');self.control(put='hold',release=True);self.tap('Open Upload Lab');self.find('Ready to request a PNG upload.')
        elif action in ['replace','identity','renderer','native-close']:
            native='close' if action=='native-close' else action
            self.tap('Upload fault controls');self.tap('Interrupt upload '+native)
            expected='proof-close' if native=='close' else 'renderer-stopped' if native=='renderer' else 'session-reuse-blocked'
            self.find('Native host failed: '+expected);self.control(put='hold',release=True);self.tap('Open Upload Lab');self.find('Ready to request a PNG upload.')
        else:self.tap('Cancel upload');self.control(put='slow-stream' if action=='stream' else 'before-tls' if action=='before-body' else 'hold',release=True)
        time.sleep(2);self.capture(action+'-revoked');self.row(action+'-ledger','not_sent' if action=='before-body' else 'unknown')
        if action=='stream':
            value=self.wait_observer('partialPuts',len(before['partialPuts'])+1,timeout=35);partial=value['partialPuts'][-1]
            assert 0<partial['bytesReceived']<partial['declaredSize']==4*1024*1024 and partial['sha256']==sha(large_wav())
            self.same_puts(before,stored=0)
        else:self.same_puts(before,count=0 if action=='before-body' else 1,stored=0 if action=='before-body' else 1)
        assert not any(n.get('text')=='Upload complete.' for n in self.nodes());self.check(action+': irreversible native stop and honest disk outcome')
    def corrupt(self,kind):
        self.reset('lost-ack');self.review();self.tap('Approve once');self.find('Upload failed.');self.row(kind+'-before','unknown');before=self.observer()
        path='/data/user/0/'+PACKAGE+'/no_backup/UploadRecovery-v1/ledger.bin';saved=self.adb('exec-out','cat',path,binary=True);self.adb('shell','am','force-stop',PACKAGE)
        if kind=='mode':self.adb('shell','chmod','644',path)
        elif kind=='symlink':self.adb('shell','mv',path,path+'.saved');self.adb('shell','ln','-s','ledger.bin.saved',path)
        else:
            damaged=bytearray(saved);damaged[-1]^=1
            subprocess.run([str(ROOT/'.tools/android-sdk/platform-tools/adb'),'-s',self.args.serial,'shell','cat > '+path],input=damaged,check=True)
        self.start();self.guest_find('Request PNG upload');self.tap('Request PNG upload');time.sleep(1);self.capture(kind+'-storage-denied')
        assert not any(n.get('text')=='Approve file upload' for n in self.nodes());assert self.observer()==before
        assert self.adb('exec-out','cat',path,binary=True)==(saved if kind!='checksum' else bytes(damaged));self.check(kind+': native disk rejection before review or network')
    def run(self):
        build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==self.report['sourceBefore'] and build['productSha256']==sha(self.args.apk.read_bytes())
        installed=self.adb('shell','pm','path',PACKAGE).removeprefix('package:');assert sha(self.adb('exec-out','cat',installed,binary=True))==build['productSha256']
        self.report.update(kind='hypergolic-android-transfer-matrix-v1',scope='Actual disposable SDK/native/TLS failures, Home, trusted Cancel and close, native configuration faults and real renderer termination; controlled private disk faults. No protected/public-provider or ordinary workspace identity proof.',productSha256=build['productSha256'],observerBefore=self.observer())
        selected=set(self.args.cases.split(',')) if self.args.cases else None
        self.report['requestedCases']=sorted(selected) if selected else 'all-21'
        for mode,state,stored in [('reject','rejected',0),('large','rejected',0),('quota','rejected',0),('wrong-receipt','unknown',1),('truncated-receipt','unknown',1),('malformed-receipt','unknown',1),('redirect','unknown',1),('drop-before-store','unknown',0),('timeout','unknown',1)]:
            if selected is None or mode in selected:self.reject_fault(mode,state,stored)
        for action in ['before-body','stream','cancel','background','close','native-close','replace','identity','renderer']:
            if selected is None or action in selected:self.interrupted(action)
        for kind in ['checksum','mode','symlink']:
            if selected is None or kind in selected:self.corrupt(kind)
        assert len(self.report['checks'])==(len(selected) if selected else 21)
        self.report['observerAfter']=self.observer();self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['status']='passed'
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for n in ['serial','apk','build','observer','output']:p.add_argument('--'+n,required=True,type=str if n=='serial' else Path)
    p.add_argument('--cases')
    journey=Matrix(p.parse_args())
    try:journey.run()
    except Exception as error:
        journey.report.update(status='failed',error=str(error))
        try:journey.capture('failure')
        except Exception:pass
        raise
    finally:journey.control(release=True);(journey.args.output/'result.json').write_text(json.dumps(journey.report,indent=2)+'\n')
