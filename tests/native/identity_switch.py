#!/usr/bin/env python3
"""Exercise identity changes only in an explicitly isolated, installed test application."""
import json
from pathlib import Path
import re
import subprocess
import time
from identity_driver import IdentityRestart, main, native_control, require_equal, single_pid, require_new_pid

class IdentitySwitch(IdentityRestart):
    scenario = 'identity-switch'
    def control(self, name):
        _, nodes = self.driver.wait(lambda rows: any(row.get('resource-id','').split('/')[-1] == name for row in rows), name)
        return native_control(nodes, name, self.package)
    def press(self, name): self.tap(self.control(name), name)
    def hide_keyboard(self):
        if re.search(r'mInputShown=true\b', self.adb('shell','dumpsys','input_method')):
            self.adb('shell','input','keyevent','4')
    def focused(self, number):
        _, nodes = self.driver.wait(lambda rows: any(row.get('resource-id','').split('/')[-1]=='focused-napplet-name' and row.get('text')==f'UX Lab {number}' for row in rows), f'UX Lab {number}')
        return nodes
    def focus(self, number):
        self.press('handle-right')
        self.press(f'overview-card-ux-lab-{number}')
        self.focused(number)
    def draft(self):
        from driver import is_draft, node_bounds
        def visible_draft(row):
            if not is_draft(row) or row.get('_webview-depth',0)==0: return False
            try:
                x1,y1,x2,y2=node_bounds(row)
                return x2>x1 and y2>y1 and x1>=0 and y1>=0
            except Exception: return False
        return self.driver.scroll_to(visible_draft, 'visible napplet draft')
    def input(self, control, text, secret=False):
        self.tap(control, 'public-test-secret' if secret else 'disposable-draft')
        # Never record input values, including publicly known test secrets, in the action log.
        self.actions.append({'operation':'native-text-input','publicFixture':True,'masked':secret})
        self.driver.adb_run('shell','input','text',text)
        self.hide_keyboard()
    def review_import(self, value):
        self.press('settings-import-identity')
        self.input(self.control('identity-import-input'), value, secret=True)
        xml, _ = self.driver.nodes()
        if value.encode() in xml: raise RuntimeError('Secret input is exposed in accessibility output')
        self.press('identity-import-review')
    def run(self):
        if self.package != 'org.nostrocket.hypergolic.identityfixture': raise RuntimeError('Requires the isolated identity test package')
        self.driver.result['scope']='Standalone Android Release test installation, actual protected identity implementation and real native input. No normal app data access.'
        self.driver.result['limitations']=['Known public disposable import key only; no real user nsec is read.','No physical-device authentication, backup/deletion, signing or saved-data wire proof.','Draft reset/retention and installed bytes are observed; private key bytes and renderer generation IDs are not inspected.']
        self.driver.result['firstLaunch']=self.cold_launch()
        original=self.settings('01')
        before_pid=single_pid(self.adb('shell','pidof',self.package))
        public_script=Path(__file__).with_name('public-test-identity.mjs')
        fixture=json.loads(subprocess.check_output([self.driver.args.node,str(public_script)],text=True))
        original_key=json.loads(subprocess.check_output([self.driver.args.node,str(public_script),original['header']],text=True))['pubkey']
        markers={n:f'IdentityDraft{int(time.time())}N{n}' for n in (1,2,3)}
        self.focused(1)
        for n in (1,2,3):
            if n!=1: self.focus(n)
            self.input(self.draft(),markers[n])
            if markers[n] not in self.draft().get('text',''): raise RuntimeError('Native draft input was not retained')
        self.press('shell-settings')
        self.review_import('invalid-nsec')
        self.control('identity-import-error')
        self.press('identity-import-cancel')
        self.review_import(fixture['nsec'])
        require_equal(fixture['npub'],self.control('identity-change-npub')['text'],'Reviewed destination')
        self.driver.capture('02-confirmation')
        self.press('identity-change-cancel')
        # Cancel returns to the cleared import form; dismiss Settings without another change.
        self.press('settings-done')
        require_equal(original['header'],self.header()[1],'Cancelled identity')
        for n in (1,2,3):
            self.focus(n)
            if markers[n] not in self.draft().get('text',''): raise RuntimeError('Cancelled change destroyed a live draft')
        self.driver.check('invalid-and-cancel-preserve-all-sessions',{'sessions':3,'npub':original['header']})
        self.press('shell-settings'); self.review_import(fixture['nsec']); self.press('identity-change-confirm')
        self.focused(3)
        require_equal(fixture['npub'],self.header()[1],'Imported selected identity')
        for n in (1,2,3):
            self.focus(n)
            text=self.draft().get('text','')
            if any(marker in text for marker in markers.values()): raise RuntimeError('Old identity draft survived accepted switch')
        self.driver.check('import-restarts-all-loaded-sessions',{'sessions':3,'npub':fixture['npub']})
        self.press('shell-settings')
        _,nodes=self.driver.nodes()
        identities=[row for row in nodes if row.get('resource-id','').split('/')[-1].startswith('identity-select-')]
        if len(identities)!=2: raise RuntimeError('Expected original and imported identities')
        self.driver.capture('03-saved-identities')
        self.review_import(fixture['nsec'])
        self.control('settings-full-npub')
        _,nodes=self.driver.nodes()
        if any(row.get('resource-id','').endswith('identity-change-confirm') for row in nodes): raise RuntimeError('Current duplicate requested another switch')
        self.press('identity-select-'+original_key)
        self.press('identity-change-cancel')
        require_equal(fixture['npub'],self.control('settings-full-npub')['text'],'Cancelled saved selector')
        self.press('identity-select-'+original_key); self.press('identity-change-confirm')
        require_equal(original['header'],self.header()[1],'Original saved identity selected')
        self.driver.check('duplicate-and-saved-selector',{'identities':2,'selectedNpub':original['header']})
        self.control('workspace-saved')
        self.driver.result['secondLaunch']=self.cold_launch()
        after_pid=single_pid(self.adb('shell','pidof',self.package)); require_new_pid(before_pid,after_pid)
        require_equal(original['header'],self.header()[1],'Selected identity after restart')
        self.press('shell-settings')
        _,nodes=self.driver.nodes()
        if len([row for row in nodes if row.get('resource-id','').split('/')[-1].startswith('identity-select-')])!=2: raise RuntimeError('Saved identities did not persist')
        self.driver.capture('04-restarted-identities')
        self.press('settings-done'); self.focused(3)
        self.driver.check('selection-inventory-and-workspace-after-restart',{'beforePid':before_pid,'afterPid':after_pid,'selectedNpub':original['header'],'title':'UX Lab 3'})
        self.driver.result['finalPid']=after_pid

if __name__=='__main__': raise SystemExit(main(scenario_type=IdentitySwitch))
