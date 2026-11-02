#!/usr/bin/env python3
"""Verify close/reopen namespaces through actual Android State Lab controls."""
import time
from state_storage import StateStorage
from identity_driver import main, require_equal, single_pid

class StateClose(StateStorage):
    scenario = 'state-close'
    def run(self):
        if self.package!='org.nostrocket.hypergolic.identityfixture':raise RuntimeError('Requires isolated identity fixture')
        self.driver.result['scope']='Isolated Android Release fixture, actual SDK and native SQLite, explicit close/reopen without app data reset.'
        self.driver.result['limitations']=['Emulator proof only; no remote loading, signing or physical-device security claim.']
        self.driver.result['firstLaunch']=self.cold_launch()
        original=self.header()[1];first=self.open_state();key='Close'+str(time.time_ns());value='Saved'+key
        self.field('key',key);self.field('value',value);self.action('write','Write confirmed.')
        self.scope(True);self.action('write','Write confirmed.');self.read(value);self.control('workspace-saved')
        title=self.control('focused-napplet-name')['text'];self.press('handle-right');self.press('overview-close-'+first)
        self.driver.wait(lambda ns:any(n.get('text')=='Close '+title+'?' for n in ns),'Exact close warning')
        self.driver.capture('01-close-warning');self.driver.check('state-close-warning',{'instance':first,'title':title})
        self.press('close-confirm');self.driver.wait(lambda ns:not any(n.get('resource-id')=='overview-card-'+first for n in ns),'Closed card removed');self.control('workspace-saved')
        second=self.open_state()
        if first==second:raise RuntimeError('New opening reused the closed instance')
        self.field('key',key);self.read(value);require_equal(original,self.header()[1],'Selected identity after reopen')
        self.driver.check('state-reopen-shared',{'closed':first,'opened':second,'value':value});self.driver.capture('02-shared-restored')
        self.scope(True);self.read(None)
        self.driver.check('state-reopen-instance',{'closed':first,'opened':second,'oldInstanceNotInherited':True});self.driver.capture('03-private-instance-fresh')
        self.driver.result['finalPid']=single_pid(self.adb('shell','pidof',self.package))

if __name__=='__main__':raise SystemExit(main(scenario_type=StateClose))
