#!/usr/bin/env python3
"""Actual SDK/native lost-ACK, disk restart, fixed-hash recovery and loaded-host navigation."""
import argparse,json,time
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
from evidence import ROOT,sha,sources,recovery_records
spec=spec_from_file_location('upload_journey',Path(__file__).with_name('android-upload.py'));module=module_from_spec(spec);spec.loader.exec_module(module)
PACKAGE=module.PACKAGE;HASH=module.HASH
class Recovery(module.Journey):
    def control(self,put='normal',get='normal',release=False):
        path=self.args.observer.parent/'control.json';temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps({'put':put,'get':get,'release':release}));temporary.replace(path)
    def wait_observer(self,key,count,timeout=20):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            value=self.observer()
            if len(value[key])>=count:return value
            time.sleep(.1)
        raise AssertionError('Observer did not reach '+key+':'+str(count))
    def disk(self,name):
        path='/data/user/0/'+PACKAGE+'/no_backup/UploadRecovery-v1/ledger.bin'
        value=self.adb('exec-out','cat',path,binary=True);(self.args.output/(name+'.bin')).write_bytes(value)
        rows=recovery_records(value);(self.args.output/(name+'.json')).write_text(json.dumps(rows,indent=2)+'\n')
        self.report.setdefault('disk',[]).append({'name':name,'sha256':sha(value),'rows':rows,'permissions':self.adb('shell',"stat -c '%a %F' "+path)})
        assert rows and all(row['identity']=='79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' and row['publisher']=='f'*64 and row['appId']=='upload-lab' and row['destination']=='https://files.example.com:19943' for row in rows)
        return rows
    def start(self):
        self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Native host connected');self.find('Ready to request a PNG upload.')
    def check_get(self,mode):
        baseline=self.observer();self.control(get=mode);self.tap('Check saved server')
        self.wait_observer('gets',len(baseline['gets'])+1)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            matches=[node for node in self.nodes() if node.get('text')=='Check saved server' or node.get('content-desc')=='Check saved server']
            if matches and any(node.get('enabled')=='true' for node in matches):break
            time.sleep(.1)
        else:raise AssertionError('Check did not finish')
        self.capture('recovery-'+mode)
        observed=self.observer();assert len(observed['requests'])==len(baseline['requests']) and len(observed['putAttempts'])==len(baseline['putAttempts'])
        assert observed['gets'][-1]['target']=='/'+HASH and observed['gets'][-1]['authorization'] is False
        rows=self.disk('recovery-'+mode);assert rows[0]['state']=='unknown'
        assert any('still unknown' in node.get('text','') for node in self.nodes());self.check(mode+' cannot settle or retry')
    def run(self):
        build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==self.report['sourceBefore'] and build['productSha256']==sha(self.args.apk.read_bytes())
        path=self.adb('shell','pm','path',PACKAGE).removeprefix('package:');assert sha(self.adb('exec-out','cat',path,binary=True))==build['productSha256']
        self.report.update(kind='hypergolic-android-recovery-v1',scope='Actual isolated SDK/native lost ACK, metadata disk/cold restart, public-address proof-gated loopback GET, current native lifecycle and two loaded hosts. Disposable identity; no protected/public provider acceptance.',productSha256=build['productSha256'])
        self.control(put='lost-ack');baseline=self.observer();self.report['observerBefore']=baseline
        self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','pm','clear',PACKAGE);self.start();self.capture('sdk-ready')
        self.review();self.tap('Reject upload');self.find('Upload cancelled.');assert self.observer()==baseline;self.tap('upload-outcome');self.check('review rejection emits zero TLS')
        self.review();self.tap('Approve once');self.find('Upload failed.');self.find('upload-recovery-open');self.capture('lost-ack-unknown')
        stored=self.wait_observer('requests',len(baseline['requests'])+1);assert stored['requests'][-1]['sha256']==HASH and stored['requests'][-1]['size']==71 and stored['requests'][-1]['signatureVerified']
        rows=self.disk('lost-ack');assert len(rows)==1 and rows[0]['state']=='unknown';record=rows[0];self.check('stored bytes and native unknown record after lost ACK')
        before=self.observer();old_pid=self.adb('shell','pidof',PACKAGE);self.adb('shell','am','force-stop',PACKAGE);self.start();assert self.adb('shell','pidof',PACKAGE)!=old_pid
        self.find('upload-recovery-open');assert self.disk('cold-restart')==rows and self.observer()==before;self.capture('cold-restart-unknown');self.check('cold restart retains metadata without read or retry')
        self.guest_find('Request PNG upload');self.tap('Request PNG upload');time.sleep(1)
        assert not any(node.get('text')=='Approve file upload' for node in self.nodes());assert self.observer()==before
        self.guest_find('upload failed');self.find('upload failed');self.capture('duplicate-hash-blocked');self.check('unresolved same provider/hash denied before review and PUT')
        self.tap('upload-recovery-open');self.find('Check interrupted uploads');self.capture('saved-provider-and-hash')
        for mode in ['wrong-hash','truncated','redirect','quota']:self.check_get(mode)
        self.control(get='hold');before=self.observer();self.tap('Check saved server');self.wait_observer('gets',len(before['gets'])+1);self.find('Checking saved server…');self.capture('native-read-held')
        old_pid=self.adb('shell','pidof',PACKAGE);self.adb('shell','input','keyevent','3');time.sleep(1)
        self.control(get='hold',release=True);time.sleep(.5);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
        assert self.adb('shell','pidof',PACKAGE)==old_pid;self.find('Check saved server');assert self.disk('background-late-read')[0]['state']=='unknown';self.capture('background-read-revoked');self.check('actual Home background irreversibly revokes held read')
        self.control();before=self.observer();self.tap('Check saved server');self.wait_observer('gets',len(before['gets'])+1)
        self.find('A matching copy is present. This check does not prove which attempt stored it.');self.capture('native-present');assert self.disk('present')[0]=={**record,'state':'present'}
        assert len(self.observer()['requests'])==len(before['requests']);self.check('complete exact hash read settles present without PUT');self.tap('Close upload checks')
        self.control();self.review();self.tap('Approve once');self.find('Upload confirmed by server.');self.tap('upload-outcome');observed=self.observer();assert len(observed['requests'])==len(baseline['requests'])+2
        self.check('new reviewed approval is required for subsequent PUT')
        self.tap('Load Peer Napplet');self.find('Native peer connected');self.control(put='hold');self.review();self.tap('Approve once');self.wait_observer('requests',len(baseline['requests'])+3);self.find('Cancel upload')
        self.tap('Switch to Peer Napplet');self.find('Peer napplet focused');self.find('Cancel upload');self.capture('two-loaded-hosts-progress')
        self.control(put='hold',release=True);self.find('Upload confirmed by server.');self.capture('peer-focus-native-completion');self.tap('upload-outcome');self.tap('Switch to Upload Lab')
        self.guest_find('Read upload status');self.tap('Read upload status')
        receipt=next((node.get('text','') for node in self.nodes() if '"status": "complete"' in node.get('text','') and HASH in node.get('text','')),None);assert receipt
        self.guest_find('Upload complete.');self.capture('original-recipient-after-peer-switch')
        receipt=next((json.loads(node.get('text','')) for node in self.nodes() if '\"status\": \"complete\"' in node.get('text','') and HASH in node.get('text','')),None)
        assert receipt and receipt['sha256']==HASH and receipt['size']==71 and receipt['mimeType']=='image/png' and receipt['url']=='https://files.example.com:19943/'+HASH+'.png'
        self.check('two actual loaded hosts preserve approved work and original SDK receipt')
        self.report['observerAfter']=self.observer();assert not self.report['observerAfter']['errors']
        self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['status']='passed'
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--serial',required=True);parser.add_argument('--apk',type=Path,required=True);parser.add_argument('--build',type=Path,required=True);parser.add_argument('--observer',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    journey=Recovery(parser.parse_args())
    try:journey.run()
    except Exception as error:
        journey.report.update(status='failed',error=str(error))
        try:journey.capture('failure')
        except Exception:pass
        raise
    finally:
        journey.control(release=True);(journey.args.output/'result.json').write_text(json.dumps(journey.report,indent=2)+'\n')
