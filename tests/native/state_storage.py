#!/usr/bin/env python3
"""Real Android State Lab SDK/storage journey in the isolated release test app."""
import json
import re
import subprocess
import time
from pathlib import Path
from driver import node_bounds, label
from identity_driver import main, native_control, single_pid, require_equal, require_new_pid
from identity_switch import IdentitySwitch

class StateStorage(IdentitySwitch):
    scenario = 'state-storage'
    def web_match(self, row, name):
        if row.get('resource-id','').split('/')[-1] != name or row.get('_webview-depth',0) < 1: return False
        try:
            x1,y1,x2,y2=node_bounds(row)
            return x2-x1>(1 if name == 'requests' else 100) and y2-y1>15 and x1>=0 and y1>=325 and y2<=2255
        except RuntimeError: return False
    def scroll(self, up=False, native=False):
        _,rows=self.driver.nodes()
        kind='android.widget.ScrollView' if native else 'android.webkit.WebView'
        found=[]
        for row in rows:
            if row.get('class')!=kind: continue
            try:
                b=node_bounds(row)
                if b[2]-b[0]>400 and b[3]-b[1]>400: found.append(b)
            except RuntimeError: pass
        if not found: raise RuntimeError('No observed scrolling surface')
        x1,y1,x2,y2=max(found,key=lambda b:(b[2]-b[0])*(b[3]-b[1]));x=(x1+x2)//2
        a=y1+(y2-y1)*3//4;b=y1+(y2-y1)//3
        if up:a,b=b,a
        self.adb('shell','input','swipe',str(x),str(a),str(x),str(b),'400')
    def web_control(self,name):
        for _ in range(6):
            _,rows=self.driver.nodes();found=[n for n in rows if self.web_match(n,name)]
            if len(found)==1:return found[0]
            if len(found)>1:raise RuntimeError('Multiple visible State Lab controls: '+name)
            self.scroll(up=name in {'scope','key','identity','identity-status'})
        raise RuntimeError('Cannot reach State Lab '+name)
    def control(self,name):
        for _ in range(6):
            _,rows=self.driver.nodes()
            try:return native_control(rows,name,self.package)
            except RuntimeError:pass
            if name.startswith(('settings-open-','overview-card-','overview-close-','identity-select-')):
                self.scroll(up=name.startswith('identity-select-'),native=True)
            else:
                self.driver.wait(lambda ns:any(n.get('resource-id','').split('/')[-1]==name for n in ns),name)
        raise RuntimeError('Cannot reach native '+name)
    def state_ready(self,expected=None):
        _,rows=self.driver.wait(lambda ns:any(n.get('text')=='Identity connected' and n.get('_webview-depth',0)>0 for n in ns),'native State Lab identity')
        statuses=[]
        for row in rows:
            if row.get('resource-id','').startswith('runtime-status-state-') and row.get('text')=='Runtime connected':
                try:
                    b=node_bounds(row)
                    if b[2]-b[0]>100:statuses.append(row)
                except RuntimeError:pass
        if len(statuses)!=1:raise RuntimeError('Expected one focused State Lab status')
        sid=statuses[0]['resource-id'].removeprefix('runtime-status-')
        if expected is not None:require_equal(expected,sid,'Focused State Lab')
        return sid
    def open_state(self,variant='state-lab'):
        self.press('shell-settings');self.press('settings-open-'+variant)
        self.driver.wait(lambda ns:not any(n.get('resource-id')=='settings-done' for n in ns),'Settings dismissed')
        return self.state_ready()
    def field(self,name,value):
        node=self.web_control(name);self.tap(node,'state-'+name)
        self.adb('shell','input','keycombination','113','29')
        self.adb('shell','input','keyevent','67')
        if value:self.adb('shell','input','text',value)
        self.hide_keyboard()
        require_equal(value,self.web_control(name).get('text',''),'Native input '+name)
    def action(self,name,expected):
        before=int(self.web_control('requests')['text'])
        self.tap(self.web_control(name),'state-'+name)
        status=self.web_control('status')
        def settled(rows):
            values=[n for n in rows if self.web_match(n,'status')]
            if not values:return False
            text=values[0].get('text','')
            if text.startswith('Request failed:'):raise RuntimeError(text)
            return text==expected if expected else bool(re.fullmatch(r'\d+ saved keys\.',text))
        self.driver.wait(settled,expected or 'Listed saved keys')
        require_equal(before+1,int(self.web_control('requests')['text']),'Request count')
    def read(self,value):
        self.action('read','No value saved.' if value is None else 'Read an empty string.' if value=='' else 'Read complete.')
        if value:require_equal(value,self.web_control('result').get('text'),'Rendered saved value')
    def scope(self,instance):
        self.tap(self.web_control('scope'),'state-scope')
        title='This instance only' if instance else 'All instances of this napplet'
        _,rows=self.driver.wait(lambda ns:any(n.get('text')==title and n.get('class')=='android.widget.CheckedTextView' for n in ns),'Native scope choice')
        choices=[n for n in rows if n.get('text')==title and n.get('class')=='android.widget.CheckedTextView']
        if len(choices)!=1:raise RuntimeError('Ambiguous scope choice')
        self.tap(choices[0],'scope-option');require_equal(title,self.web_control('scope')['text'],'Selected scope')
    def focus_state(self,sid):
        # The newly opened variants are adjacent in opening order; use the real edge gesture.
        for _ in range(16):
            current=self.state_ready()
            if current==sid:return
            _,rows=self.driver.nodes();title=native_control(rows,'focused-napplet-name',self.package)['text']
            grip=self.control('handle-left');stage=self.control('shell-stage')
            x1,y1,x2,y2=node_bounds(grip);a,b,c,d=node_bounds(stage)
            self.adb('shell','input','swipe',str((x1+x2)//2),str((y1+y2)//2),str((a+c)//2),str((y1+y2)//2),'350')
            self.driver.wait(lambda ns:any(n.get('resource-id')=='focused-napplet-name' and n.get('text')!=title for n in ns),'Previous napplet after edge swipe')
        raise RuntimeError('Original State Lab not reached')
    def run(self):
        if self.package!='org.nostrocket.hypergolic.identityfixture':raise RuntimeError('Requires isolated identity fixture')
        self.driver.result['scope']='Installed Android Release fixture, actual SDK/Kehto/native lease broker and Expo SQLite through public native input; no app data reset.'
        self.driver.result['limitations']=['Emulator only; no physical-device authentication, signing or remote artifact proof.','Public fixture values only; direct database/private-key inspection is not used.']
        self.driver.result['firstLaunch']=self.cold_launch()
        original=self.header()[1];first=self.open_state();key='State'+str(time.time_ns());value='Stored'+key
        self.driver.result['fixtureKey']=key
        public=self.web_control('identity')['text']
        helper=Path(__file__).with_name('public-test-identity.mjs')
        decoded=json.loads(subprocess.check_output([self.driver.args.node,str(helper),original],text=True))['pubkey']
        require_equal(decoded,public,'SDK and native identity')
        self.driver.check('state-identity',{'npub':original,'pubkey':public,'instance':first})
        self.field('key',key);self.read(None);self.action('write','Write confirmed.');self.read('')
        self.field('value',value);self.action('write','Write confirmed.');self.read(value);self.action('keys',None)
        _,rows=self.driver.nodes()
        if not any(n.get('text')==key and n.get('_webview-depth',0)>0 for n in rows):raise RuntimeError('Saved key not listed')
        self.action('remove','Remove confirmed.');self.read(None);self.action('write','Write confirmed.');self.read(value)
        self.driver.check('state-storage-operations',{'key':key,'value':value,'missingAndEmptyDistinct':True});self.driver.capture('01-state-saved')
        self.scope(True);self.read(None);self.field('value','Private'+key);self.action('write','Write confirmed.')
        self.control('workspace-saved');before=single_pid(self.adb('shell','pidof',self.package));self.driver.result['secondLaunch']=self.cold_launch();self.state_ready(first)
        after=single_pid(self.adb('shell','pidof',self.package));require_new_pid(before,after);require_equal(original,self.header()[1],'Restarted identity')
        self.field('key',key);self.read(value);self.scope(True);self.read('Private'+key)
        self.driver.check('state-restart',{'beforePid':before,'afterPid':after,'instance':first,'sharedAndInstanceRestored':True});self.driver.capture('02-state-restarted')
        second=self.open_state();self.field('key',key);self.read(value);self.scope(True);self.read(None)
        self.driver.check('state-instance-scope',{'first':first,'second':second,'shared':value})
        for variant in ['state-lab-peer','state-lab-other-publisher']:
            sid=self.open_state(variant);self.field('key',key);self.read(None)
        self.driver.check('state-owner-isolation',{'key':key,'appAndPublisherIsolated':True})
        self.focus_state(first);self.scope(False);self.read(value);self.press('shell-settings')
        _,rows=self.driver.nodes();others=[n for n in rows if n.get('resource-id','').startswith('identity-select-') and not n['resource-id'].endswith(public)]
        if len(others)!=1:raise RuntimeError('Expected one other saved identity')
        other=others[0]['resource-id'];self.press(other);self.press('identity-change-cancel');self.press('settings-done');self.read(value)
        self.press('shell-settings');self.press(other);self.press('identity-change-confirm');self.state_ready(first);self.field('key',key);self.read(None)
        self.press('shell-settings');self.press('identity-select-'+public);self.press('identity-change-confirm');self.state_ready(first);self.field('key',key);self.read(value)
        require_equal(original,self.header()[1],'Restored identity');self.driver.check('state-identity-isolation',{'npub':original,'returnedValue':value});self.driver.capture('03-identity-restored')
        self.driver.result['finalPid']=single_pid(self.adb('shell','pidof',self.package))

if __name__=='__main__':raise SystemExit(main(scenario_type=StateStorage))
