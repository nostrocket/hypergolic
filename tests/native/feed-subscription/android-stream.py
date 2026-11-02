#!/usr/bin/env python3
"""Real read-only SDK/native WSS lifecycle journey in the isolated Android fixture."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import xml.etree.ElementTree as ET
ROOT = Path(__file__).resolve().parents[3]
PACKAGE = 'org.nostrocket.hypergolic.feedstreamfixture'
def digest(data): return hashlib.sha256(data).hexdigest()
def sources():
    paths = subprocess.check_output(['git','-C',str(ROOT),'ls-files','-co','--exclude-standard','-z']).decode().split('\0')
    selected = {p for p in paths if p.startswith(('src/','modules/napplet-host/','runtime/src/','runtime/fixtures/','tests/native/feed-subscription/')) or p in ('package.json','pnpm-lock.yaml')}
    selected.update(['runtime/dist/index.html','runtime/dist/host.js'])
    return {p:digest((ROOT/p).read_bytes()) for p in sorted(selected) if (ROOT/p).is_file()}
class Journey:
    def __init__(self,args):
        self.args=args;self.out=args.output;self.out.mkdir(parents=True,exist_ok=False)
        self.report={'kind':'hypergolic-android-relay-stream-v1','status':'running','checks':[],'inputs':[],'sourceBefore':sources(),
            'scope':'Real isolated public-only SDK/native WSS lifecycle. Public-owner fixture revocation is not protected identity UI acceptance.'}
    def adb(self,*args,binary=False):
        value=subprocess.check_output([self.args.adb,'-s',self.args.serial,*args],timeout=30)
        return value if binary else value.decode().strip()
    def nodes(self):
        self.adb('shell','uiautomator','dump','--compressed','/data/local/tmp/hg-stream.xml')
        self.xml=self.adb('exec-out','cat','/data/local/tmp/hg-stream.xml',binary=True)
        nodes=list(ET.fromstring(self.xml).iter('node'))
        if not any(n.get('package')==PACKAGE for n in nodes):raise RuntimeError('Intended stream fixture is not foreground')
        return nodes
    def observe(self,predicate,timeout=30):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            result=predicate(self.nodes())
            if result is not None and result is not False:return result
            time.sleep(.2)
        raise RuntimeError('Timed out observing native stream state')
    def find(self,label):
        def select(nodes):
            matches=[n for n in nodes if n.get('text')==label or n.get('content-desc')==label]
            buttons=[n for n in matches if n.get('clickable')=='true']
            return buttons[0] if len(buttons)==1 else matches[0] if len(matches)==1 else None
        return self.observe(select)
    def input(self,*args):
        self.report['inputs'].append(list(args));return self.adb('shell','input',*args)
    def tap(self,node):
        bounds=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds',''))
        if not bounds:raise RuntimeError('No observed control bounds')
        x,y,a,b=map(int,bounds.groups())
        if a<=x or b<=y:raise RuntimeError('Control is outside viewport')
        self.input('tap',str((x+a)//2),str((y+b)//2))
    def button(self,name):self.tap(self.find(name))
    def field(self,index,value):
        fields=[n for n in self.nodes() if n.get('class')=='android.widget.EditText']
        if len(fields)!=2:raise RuntimeError('Expected filters and draft inputs')
        self.tap(fields[index]);self.nodes();self.input('keycombination','113','29');self.input('text',shlex.quote(value))
        fields=[n for n in self.nodes() if n.get('class')=='android.widget.EditText']
        if fields[index].get('text')!=value:raise RuntimeError('Exact native input was not retained')
        self.input('keyevent','4')
    def draft(self,value):
        assert any(n.get('class')=='android.widget.EditText' and n.get('text')==value for n in self.nodes()),'Draft lost'
    def live(self,minimum=1):
        def select(nodes):
            for node in nodes:
                match=re.fullmatch(r'Live · (\d+) signed notes? · history loaded\.',node.get('text',''))
                if match and int(match[1])>=minimum:return int(match[1])
            return None
        return self.observe(select)
    def counters(self):
        self.button('Read stream counters')
        def select(nodes):
            for node in nodes:
                match=re.fullmatch(r'Streams opened (\d+), stopped (\d+), frames (\d+), EOSE (\d+), background (\d+), foreground (\d+)',node.get('text',''))
                if match:return list(map(int,match.groups()))
        value=self.observe(select);self.report.setdefault('counters',[]).append(value);return value
    def capture(self,name):
        self.nodes();(self.out/(name+'.xml')).write_bytes(self.xml)
        self.report.setdefault('eventIds',{})[name]=[n.get('text') for n in ET.fromstring(self.xml).iter('node') if re.fullmatch('[0-9a-f]{64}',n.get('text',''))]
        image=self.adb('exec-out','screencap','-p',binary=True);assert image.startswith(b'\x89PNG')
        (self.out/(name+'.png')).write_bytes(image);self.report.setdefault('captures',[]).append({'name':name,'sha256':digest(image),'visuallyInspected':False})
    def check(self,name):self.report['checks'].append(name);print('PASS '+name,flush=True)
    def launch(self):self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Switch feed')
    def run(self):
        installed=self.adb('shell','pm','path',PACKAGE).removeprefix('package:')
        apk=self.adb('exec-out','cat',installed,binary=True);assert digest(apk)==digest(self.args.apk.read_bytes())
        self.report['installedApkSha256']=digest(apk);self.report['webView']=self.adb('shell','dumpsys','webviewupdate')
        self.adb('shell','am','force-stop',PACKAGE);self.launch()
        self.field(0,'[{"kinds":[1],"limit":4}]');self.field(1,'draft-A-retained');self.button('Start live feed')
        first=self.live();self.check('signed-history-and-eose');self.capture('stream-history')
        # Passing the ordinary 27 second lease is part of the native stream lifetime proof.
        time.sleep(28);later=self.live(first+1);self.check('live-after-eose-and-ordinary-lease');self.capture('stream-live')
        before=self.counters();self.button('Switch feed');self.find('Feed B foreground · owner 0')
        self.field(0,'[{"kinds":[1],"limit":4}]');self.field(1,'draft-B-retained');self.button('Start live feed');self.live()
        self.button('Switch feed');self.find('Feed A foreground · owner 0');self.draft('draft-A-retained');self.live(later)
        switched=self.counters();assert switched[0]==before[0]+1 and switched[1]==before[1],'Switch reopened or closed a loaded feed'
        self.check('switch-retains-live-connections-and-drafts');self.capture('stream-switched')
        count=self.live();pid=self.adb('shell','pidof',PACKAGE);self.input('keyevent','3');time.sleep(3);self.launch();assert self.adb('shell','pidof',PACKAGE)==pid,'Process died during background/return';self.draft('draft-A-retained');self.live(count)
        returned=self.counters();assert returned[0]>=switched[0]+2 and returned[1]>=switched[1]+2 and returned[4]>switched[4], 'Background did not close and reconnect both loaded streams'
        self.check('background-retains-view-and-refreshes-connections');self.capture('stream-returned')
        self.button('Close live feed');self.find('Live feed closed.');closed=self.counters();assert closed[1]>returned[1]
        time.sleep(3);self.find('Live feed closed.');self.draft('draft-A-retained');self.check('explicit-close-revokes-live-delivery');self.capture('stream-closed')
        self.button('Start live feed');self.live();reopened=self.counters();assert reopened[0]>closed[0]
        self.button('Close feed A');self.find('Open feed A');removed=self.counters();assert removed[1]>reopened[1]
        self.check('view-removal-revokes-stream');self.capture('stream-view-removed')
        self.button('Change public owner');self.find('Feed A foreground · owner 1');revoked=self.counters();assert revoked[1]==revoked[0], 'Old public owner retains a stream'
        self.input('keyevent','3');time.sleep(2);self.launch();assert self.counters()[0]==revoked[0], 'Revoked intent reconnected'
        self.check('public-owner-revocation-no-reconnect')
        self.adb('shell','am','force-stop',PACKAGE);self.launch();self.find('Live feed closed.');assert self.counters()[0]==0
        self.check('cold-restart-no-old-intent');self.capture('stream-cold-restart')
        self.report['sourceAfter']=sources();assert self.report['sourceBefore']==self.report['sourceAfter'],'Source changed during journey'
        self.report['status']='passed'
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--serial',required=True);parser.add_argument('--adb',default=str(ROOT/'.tools/android-sdk/platform-tools/adb'));parser.add_argument('--apk',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    journey=Journey(parser.parse_args())
    try:journey.run()
    except Exception as error:journey.report.update(status='failed',error=str(error));raise
    finally:(journey.out/'result.json').write_text(json.dumps(journey.report,indent=2)+'\n')
