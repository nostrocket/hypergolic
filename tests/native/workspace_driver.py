#!/usr/bin/env python3
"""Real Android workspace scenarios using native input and causally correlated existing WebViews."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid
import driver as base
from driver import CheckFailed, exactly_one, label, node_bounds, outer_webview, is_increment, run, parse_nodes
from observations import assert_state, common_increment, correlate_counter, identity, native_focus, positive_area, require_two_columns, same_instances, target_map, target_at_native_bounds, visible_control, visible_webview
from motion_recording import record_native_motion

HERE=Path(__file__).resolve().parent


def short_card_stroke(bounds, density_output):
    """Derive a 20dp native stroke from observed display density and card bounds."""
    densities = {}
    for line in density_output.splitlines():
        match = re.fullmatch(r'\s*(Physical|Override) density:\s*(.*?)\s*', line)
        if not match:
            continue
        kind, value = match.groups()
        if kind in densities or not value.isdigit() or int(value) <= 0:
            raise CheckFailed('Ambiguous or invalid observed Android display density')
        densities[kind] = int(value)
    density = densities.get('Override', densities.get('Physical'))
    if density is None:
        raise CheckFailed('No observed Android display density')
    x1, y1, x2, y2 = bounds
    travel = round(20 * density / 160)
    x, y = round((x1 + x2) / 2), round((y1 + y2) / 2)
    if travel <= 0 or not x1 < x < x2 or not y1 < y - travel < y < y2:
        raise CheckFailed('Short stroke leaves the observed card')
    return {'densityDpi': density, 'travelNativePixels': travel, 'requestedLogicalPixels': 20,
            'durationMs': 13, 'points': (x, y, x, y - travel)}


def retained_overview_cards(nodes):
    """A stale header or hidden card cannot establish a retained overview."""
    if any(node.get('resource-id', '').endswith('close-confirm') for node in nodes):
        raise CheckFailed('Short stroke opened a close warning')
    if any(label(node).endswith('napplet handle') for node in nodes):
        raise CheckFailed('Focused handles survive the claimed overview')
    exactly_one(nodes, lambda node: label(node) == 'Your napplets', 'retained overview heading')
    expected = ['Open UX Lab 1', 'Open UX Lab 2', 'Open UX Lab 3']
    actual = [label(node) for node in nodes if label(node).startswith('Open UX Lab ')]
    if sorted(actual) != expected:
        raise CheckFailed('Short stroke changed or duplicated the overview card inventory')
    return [exactly_one(nodes, lambda node, title=title: label(node) == title, title) for title in expected]

class WorkspaceDriver(base.Driver):
    def __init__(self,args):
        base.ROOT=Path(args.source).resolve()
        super().__init__(args)
        self.port=None
        self.bindings={}
        self.expected={}
        self.observation_number=0
        self.motion_number=0
        self.result['harnessBefore']=self.harness_hashes()
        self.result['scope']='Actual Android debug three-session UX fixture; native inputs, exact target/context observations; no release/full-v1 claim'

    def check(self,name,details):
        super().check(name,details)
        print('PASS '+name,flush=True)

    def adb_run(self,*args,**kwargs):
        if len(args)>=2 and args[:2]==('shell','input'):
            receipt={'arguments':list(args),'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
            self.result.setdefault('nativeInputs',[]).append(receipt)
            result=super().adb_run(*args,**kwargs)
            receipt['completed']=True
            return result
        return super().adb_run(*args,**kwargs)

    def nodes(self):
        # Full UIAutomator dumps deliberately request not-important views. The
        # compressed hierarchy respects that filter and is the useful AX scope.
        self.adb_run('shell','uiautomator','dump','--compressed','/sdcard/hypergolic-driver-ui.xml',timeout=15)
        xml=self.adb_run('exec-out','cat','/sdcard/hypergolic-driver-ui.xml',binary=True)
        nodes=parse_nodes(xml)
        if not any(n.get('package')==self.args.package for n in nodes):
            raise CheckFailed('Target package is not visible in Android hierarchy')
        return xml,nodes

    def capture(self,name):
        # A stuck hierarchy dump must not erase the actual screen at failure.
        png=self.adb_run('exec-out','screencap','-p',binary=True,timeout=15)
        if not png.startswith(b'\x89PNG\r\n\x1a\n'):raise CheckFailed('Screenshot is not PNG')
        (self.out/(name+'.png')).write_bytes(png)
        record={'name':name,'pngSha256':hashlib.sha256(png).hexdigest(),'visuallyInspected':False}
        self.result['captures'].append(record)
        try:
            xml,nodes=self.nodes()
            (self.out/(name+'.xml')).write_bytes(xml)
            record['xmlSha256']=hashlib.sha256(xml).hexdigest()
            return nodes
        except Exception as error:
            record['hierarchyError']=str(error)
            raise

    def source_hashes(self):
        paths=[*base.ROOT.glob('src/shell/*'),base.ROOT/'src/App.tsx',base.ROOT/'src/runtime/NappletHost.tsx',
          *base.ROOT.glob('modules/napplet-host/android/src/main/**/*.kt'),
          *[base.ROOT/name for name in ('index.ts','package.json','pnpm-lock.yaml','app.json','modules/napplet-host/expo-module.config.json',
             'runtime/assets-manifest.json','runtime/dist/index.html','runtime/dist/host.js')]]
        return {str(file.relative_to(base.ROOT)):hashlib.sha256(file.read_bytes()).hexdigest() for file in paths if file.is_file()}

    @staticmethod
    def harness_hashes():
        return {name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in
          ('workspace_driver.py','driver.py','receiver.py','observations.py','target-probe.mjs','motion_recording.py')}

    def motion(self,name,action):
        if not self.args.record_motion:return action()
        self.motion_number+=1
        record_native_motion(self,f'motion-{self.motion_number:02}-{name}',action)

    def prepare(self):
        self.metadata()
        expected=self.args.expected_apk_sha256
        if self.result['app']['installedBaseApkSha256'] != expected:
            raise CheckFailed('Installed APK differs from explicit native-build handoff hash')
        if set(self.result['app']['installedRuntimeAssetSha256'])!={'assets/runtime/index.html','assets/runtime/host.js'}:
            raise CheckFailed('Installed runtime asset inventory is incomplete')
        for name,digest in self.result['app']['installedRuntimeAssetSha256'].items():
            source=base.ROOT/'runtime/dist'/Path(name).name
            if not source.exists() or hashlib.sha256(source.read_bytes()).hexdigest()!=digest:
                raise CheckFailed('Installed native runtime assets differ from current built assets')
        self.result['sourceBefore']=self.source_hashes()
        self.result['source']['debugMetroCodeBinding']='Current workspace source hashes before/after; debug Metro payload itself is not a standalone embedded-JS binary attestation'
        if self.args.cold_launch:
            old=self.adb_run('shell','pidof',self.args.package,check=False).split()
            self.adb_run('shell','am','force-stop',self.args.package)
            launch=self.adb_run('shell','am','start','-W','-n',self.args.package+'/.MainActivity')
            self.result['coldLaunch']={'previousPids':old,'command':'am force-stop; am start -W explicit package/.MainActivity',
              'launchOutput':launch,'dataCleared':False,'reason':'Explicit root handoff; do not rely on disconnected HMR or intercepted Debugger.getScriptSource'}
            new=self.adb_run('shell','pidof',self.args.package).split()
            if len(new)!=1 or new==old:raise CheckFailed('Explicit cold launch did not produce a new native app process')
        # A successful native Activity launch precedes the Metro bundle and native
        # WebView creation. Wait for actual ready UI before admitting its socket.
        self.wait(lambda ns:self.focus_matches(ns,'UX Lab 1'),'initial focused UX Lab 1 runtime readiness')
        pid=self.adb_run('shell','pidof',self.args.package).split()
        if len(pid)!=1:raise CheckFailed('Need exactly one current-app process')
        self.pid=pid[0]
        socket='webview_devtools_remote_'+self.pid
        sockets=self.adb_run('shell','cat','/proc/net/unix')
        if not any(line.endswith('@'+socket) for line in sockets.splitlines()):
            raise CheckFailed('No observed app-owned DevTools socket')
        port=self.adb_run('forward','tcp:0','localabstract:'+socket)
        if not port.isdigit():raise CheckFailed('ADB did not allocate a private diagnostic port')
        self.port=port
        self.result['transport']={'appPid':self.pid,'socket':socket,'allocatedLocalPort':int(port)}
        # Load each retained session through native input before comparing target identity.
        for side, title in [('right', 'UX Lab 2'), ('right', 'UX Lab 3'), ('left', 'UX Lab 2'), ('left', 'UX Lab 1')]:
            self.handle(side, title)
        _,nodes=self.wait(lambda ns:self.focus_matches(ns,'UX Lab 1'),'initial focused UX Lab 1')
        rows=self.wait_targets(lambda observed: len(observed) == 3, 'three rendered fixture targets')
        if len(rows)!=3:raise CheckFailed('Scenario requires exactly three initially loaded fixtures')
        self.initial_rows=copy.deepcopy(rows)
        self.capture('01-initial-three')
        self.result['androidFixtureAccessibility']={'descendantsExposed':any(label(n).startswith('Ready ·') for n in nodes),
          'hierarchyMode':'uiautomator dump --compressed; excludes FLAG_INCLUDE_NOT_IMPORTANT_VIEWS',
          'numericCounter':'Read-only DOM values; not a screen-reader numeric-value pass'}

    @staticmethod
    def focus_matches(nodes,title):
        try:return native_focus(nodes, require_status=False)['title']==title
        except CheckFailed:return False

    def focused(self,title=None):
        _,nodes=self.wait(lambda ns:self.focus_matches(ns,title) if title else self.has_native_focus(ns),'one focused native fixture')
        return native_focus(nodes, require_status=False),nodes

    @staticmethod
    def has_native_focus(nodes, require_status=False):
        try:native_focus(nodes, require_status=False);return True
        except CheckFailed:return False

    def observe(self,mode='snapshot'):
        self.observation_number+=1
        path=self.out/f'targets-{self.observation_number:03}-{mode}.json'
        output=run([shutil.which('node'),HERE/'target-probe.mjs','--port',self.port,'--mode',mode,'--output',path],timeout=25)
        value=json.loads(output)
        if value.get('status')!='passed':raise CheckFailed('Exact target observation did not complete')
        return value['targets']

    def wait_targets(self,predicate,description,mode='snapshot'):
        deadline=time.monotonic()+self.args.timeout
        last=None
        while time.monotonic()<deadline:
            try:
                rows=self.observe(mode)
                if predicate(rows):return rows
            except (CheckFailed,subprocess.TimeoutExpired) as error:last=str(error)
            time.sleep(.15)
        raise CheckFailed('Timed out observing '+description+((': '+last) if last else ''))

    def row(self,title):
        binding=self.bindings.get(title)
        if not binding:raise CheckFailed('Fixture has no causally observed target binding: '+title)
        rows=self.observe()
        matches=[row for row in rows if identity(row)==binding]
        if len(matches)!=1:raise CheckFailed('Bound native generation/frame/context no longer exists')
        return matches[0]

    def tap_rect(self,snapshot,box):
        _,nodes=self.focused()
        x1,y1,x2,y2=node_bounds(visible_webview(nodes))
        x=x1+(box['x']+box['width']/2)*(x2-x1)/snapshot['viewport']['width']
        y=y1+(box['y']+box['height']/2)*(y2-y1)/snapshot['viewport']['height']
        if not(x1<x<x2 and y1<y<y2):raise CheckFailed('Observed child rectangle maps outside visible native WebView')
        self.adb_run('shell','input','tap',str(round(x)),str(round(y)))

    def correlate(self,title):
        for _ in range(18):
            before=self.observe()
            focused,nodes=self.focused(title)
            geometric=target_at_native_bounds(before,focused['webViewBounds'])
            try:visible_control(geometric['snapshot'],'increment');break
            except CheckFailed:
                x1,y1,x2,y2=focused['webViewBounds']
                self.swipe(((x1+x2)/2,y1+(y2-y1)*.3,(x1+x2)/2,y1+(y2-y1)*.8),500)
        else:raise CheckFailed('Native scrolling did not reveal counter for source-bound correlation')
        increment=[node for node in nodes if is_increment(node) and positive_area(node)]
        if len(increment)==1:
            self.tap(increment[0]); coordinate='native accessibility Add one'
        else:
            snapshot=geometric['snapshot'];box=visible_control(snapshot,'increment')
            self.tap_rect(snapshot,box);coordinate='exact Chromium renderer screen rectangle matched to unique native WebView bounds'
        after=self.wait_targets(lambda rows:any(row['snapshot']['counter']!=target_map(before)[row['id']]['snapshot']['counter'] for row in rows if row['id'] in target_map(before)), 'one native counter increment')
        changed=correlate_counter(before,after)
        if identity(changed)!=identity(geometric):raise CheckFailed('Causal native input disagrees with independently observed Chromium/native geometry')
        binding=identity(changed)
        if title in self.bindings and self.bindings[title]!=binding:raise CheckFailed('Native focus returned to a different target')
        if any(other!=title and value==binding for other,value in self.bindings.items()):raise CheckFailed('Two native napplet names map to the same loaded target')
        self.bindings[title]=binding
        self.check('causal-focus-binding',{'native':focused,'targetId':changed['id'],'nativeGeneration':changed['generation'],
          'frameId':changed['frameId'],'contextUniqueId':changed['contextUniqueId'],'coordinateSource':coordinate})
        return changed

    def swipe(self,points,duration=400):
        self.adb_run('shell','input','swipe',*(str(round(value)) for value in points),str(duration))

    def handle(self,side,title,kind='switch'):
        _,nodes=self.focused()
        handle=exactly_one(nodes,lambda n:label(n)==side.capitalize()+' napplet handle',side+' inset handle')
        x1,y1,x2,y2=node_bounds(handle)
        web=node_bounds(visible_webview(nodes));width=web[2]-web[0]
        x,y=(x1+x2)/2,(y1+y2)/2
        if kind=='tap':self.motion(side+'-tap-overview',lambda:self.tap(handle))
        else:
            distance=width*(.075 if kind=='cancel' else .42)
            self.motion(side+'-'+kind,lambda:self.swipe((x,y,x+(distance if side=='left' else -distance),y),600 if kind=='cancel' else 420))
        if kind!='tap':self.focused(title)

    def reveal(self,title,name):
        for _ in range(18):
            self.focused(title)
            row=self.row(title);snapshot=row['snapshot'];box=snapshot['controls'].get(name)
            try:return snapshot,visible_control(snapshot,name)
            except CheckFailed:pass
            _,nodes=self.focused(title);x1,y1,x2,y2=node_bounds(visible_webview(nodes))
            if box and box['y']>=0 and box['y']+box['height']<=snapshot['viewport']['height'] and name.startswith('marker-'):
                rail=visible_control(snapshot,'rail')
                scale=(x2-x1)/snapshot['viewport']['width']
                left=x1+rail['x']*scale;right=left+rail['width']*scale
                y=y1+(rail['y']+rail['height']/2)*(y2-y1)/snapshot['viewport']['height']
                forward=box['x']>snapshot['viewport']['width']/2
                a,b=(.8,.2) if forward else (.2,.8)
                self.swipe((left+(right-left)*a,y,left+(right-left)*b,y),500)
            else:
                down=box is None or box['y']>snapshot['viewport']['height']/2
                a,b=(.90,.45) if down else (.35,.77)
                self.swipe(((x1+x2)/2,y1+(y2-y1)*a,(x1+x2)/2,y1+(y2-y1)*b),500)
        raise CheckFailed('Native scrolling did not reveal '+name)

    def dismiss_keyboard(self):
        if re.search(r'mInputShown=true\b',self.adb_run('shell','dumpsys','input_method')):
            self.adb_run('shell','input','keyevent','4')
            deadline=time.monotonic()+5
            while re.search(r'mInputShown=true\b',self.adb_run('shell','dumpsys','input_method')):
                if time.monotonic()>deadline:raise CheckFailed('Keyboard did not dismiss')
                time.sleep(.1)

    def configure(self,title,number):
        row=self.correlate(title)
        for _ in range(number):
            snapshot,box=self.reveal(title,'increment');self.tap_rect(snapshot,box)
        old=self.row(title)['snapshot']['draft']
        snapshot,box=self.reveal(title,'draft');self.tap_rect(snapshot,box)
        marker='Android'+str(number)+'_'+uuid.uuid4().hex[:10]
        # Wait for the actual IME, then pace physical key injection against observed
        # DOM input events. A single input-text burst can race initial IME setup.
        deadline=time.monotonic()+10
        while not re.search(r'mInputShown=true\b',self.adb_run('shell','dumpsys','input_method')):
            if time.monotonic()>deadline:raise CheckFailed('Textarea did not open the Android keyboard')
            time.sleep(.1)
        _,nodes=self.nodes()
        if any(label(n)=='Try out your stylus' for n in nodes):
            raise CheckFailed('Gboard stylus onboarding overlays fixture; dismiss it visibly before another run')
        self.adb_run('shell','input','keyevent','123')
        self.result.setdefault('typedMarkers',[]).append({'title':title,'marker':marker})
        for index,character in enumerate(marker):
            self.adb_run('shell','input','text',character)
            prefix=old+marker[:index+1]
            binding=self.bindings[title]
            self.wait_targets(lambda rows:any(identity(row)==binding and row['snapshot']['draft']==prefix
              and row['snapshot']['mirror']==prefix for row in rows),'exact paced native input prefix')
        self.dismiss_keyboard()
        draft=self.row(title)['snapshot']
        if draft['draft']!=old+marker or draft['mirror']!=old+marker:raise CheckFailed('Native typing did not update exact draft and mirror')
        selected=number*2+1
        snapshot,box=self.reveal(title,'marker-'+str(selected));self.tap_rect(snapshot,box)
        row=self.row(title)
        if row['snapshot']['selected']!=f'{selected:02}':raise CheckFailed('Native horizontal marker selection failed')
        if row['snapshot']['scroll']['rail']<=0:raise CheckFailed('No actual horizontal rail scrolling observed')
        snapshot,box=self.reveal(title,'edge-left-'+str(number));self.tap_rect(snapshot,box)
        row=self.row(title)
        if row['snapshot']['edge']!=f'Left / {number:02}' or row['snapshot']['scroll']['y']<=0:
            raise CheckFailed('Vertical scrolling/edge control interaction unproven')
        self.expected[title]=copy.deepcopy(row['snapshot'])
        self.check('distinct-native-state',{'title':title,'counter':row['snapshot']['counter'],'draft':marker,
          'selected':row['snapshot']['selected'],'edge':row['snapshot']['edge'],'scroll':row['snapshot']['scroll']})
        self.capture('configured-'+str(number))

    def verify_return(self,title):
        focused,_=self.focused(title)
        row=target_at_native_bounds(self.observe(),focused['webViewBounds'])
        if identity(row)!=self.bindings[title]:raise CheckFailed('Native focused title points at the wrong live WebView')
        assert_state(self.expected[title],row['snapshot'])
        same_instances(self.initial_rows,self.observe())
        self.check('state-retained-on-return',{'title':title,'binding':self.bindings[title],'scroll':row['snapshot']['scroll']})

    def overview(self,side='right'):
        before=self.observe()
        self.handle(side,None,'tap')
        _,nodes=self.wait(lambda ns:any(label(n)=='Your napplets' for n in ns),'native overview')
        if any(label(n).endswith('napplet handle') for n in nodes):raise CheckFailed('Hidden handles leak into overview accessibility')
        same_instances(before,self.observe())
        return nodes

    def open_card(self,title):
        _,nodes=self.wait(lambda ns:any(label(n)=='Open '+title for n in ns),'overview card '+title)
        card=exactly_one(nodes,lambda n:label(n)=='Open '+title,'overview card')
        self.motion('open-'+title.replace(' ','-'),lambda:self.tap(card))
        self.focused(title)

    def switch_state(self):
        for number in (1,2,3):
            title='UX Lab '+str(number)
            self.configure(title,number)
            if number<3:self.handle('right','UX Lab '+str(number+1))
        if len(set(self.bindings.values()))!=3:raise CheckFailed('Three independent targets were not established')
        for number in (2,1):self.handle('left','UX Lab '+str(number));self.verify_return('UX Lab '+str(number))
        for number in (2,3):self.handle('right','UX Lab '+str(number));self.verify_return('UX Lab '+str(number))
        nodes=self.overview()
        self.check('two-column-opening-order',require_two_columns(nodes,['UX Lab 1','UX Lab 2','UX Lab 3']))
        for title in ('UX Lab 1','UX Lab 2','UX Lab 3'):assert_state(self.expected[title],self.row(title)['snapshot'])
        self.capture('overview-three-live')
        self.open_card('UX Lab 1');self.verify_return('UX Lab 1')
        # A final physical interaction confirms the restored named session owns the visible WebView.
        self.reveal('UX Lab 1','increment');self.correlate('UX Lab 1')

    def gestures(self):
        self.correlate('UX Lab 1')
        before=self.observe()
        self.handle('right','UX Lab 1','cancel')
        self.handle('left','UX Lab 1')
        same_instances(before,self.observe())
        self.check('short-drag-and-first-end','Native title/generation remained UX Lab 1')
        self.handle('right','UX Lab 2');self.correlate('UX Lab 2')
        self.handle('right','UX Lab 3');self.correlate('UX Lab 3')
        self.handle('right','UX Lab 3')
        self.check('last-end-does-not-wrap','Native title remained UX Lab 3')
        nodes=self.overview('right');require_two_columns(nodes,['UX Lab 1','UX Lab 2','UX Lab 3']);self.capture('gestures-overview')
        self.open_card('UX Lab 1');self.overview('left');self.open_card('UX Lab 2')
        same_instances(before,self.observe())
        self.check('both-end-taps-and-card-return','Both handles opened observed native overview; card selected UX Lab 2; targets/contexts retained')
        self.handle('left','UX Lab 1')
        self.result['limitations'].append('Gesture completion/cancellation/end order is checked. Recorded motion requires independent frame/video inspection; no automatic visual quality or frame-pacing pass is inferred.')

    def overview_scroll(self):
        self.correlate('UX Lab 1')
        before=self.observe()
        nodes=self.overview()
        card=exactly_one(nodes,lambda n:label(n)=='Open UX Lab 1','first overview card')
        x1,y1,x2,y2=node_bounds(card)
        self.capture('before-gentle-card-scroll')
        self.swipe(((x1+x2)/2,y1+(y2-y1)*.78,(x1+x2)/2,y1+(y2-y1)*.23),1600)
        def moved(nodes):
            if any(n.get('resource-id','').endswith('close-confirm') for n in nodes):
                raise CheckFailed('Gentle card scroll unexpectedly requested closing')
            candidates=[n for n in nodes if label(n)=='Open UX Lab 1' and positive_area(n)]
            return len(candidates)==1 and y1-node_bounds(candidates[0])[1]>40
        _,nodes=self.wait(moved,'gentle upward card drag moves actual overview by >40 native pixels',timeout=10)
        after=self.observe();same_instances(before,after)
        for key,row in target_map(before).items():assert_state(row['snapshot'],target_map(after)[key]['snapshot'])
        moved_card=exactly_one(nodes,lambda n:label(n)=='Open UX Lab 1','moved first overview card')
        self.check('gentle-card-scroll',{'before':(x1,y1,x2,y2),'after':node_bounds(moved_card),'durationMs':1600,
          'nativePixelTravel':(y2-y1)*.55,'allFixtureStatesRetained':True})
        self.capture('after-gentle-card-scroll')

    def closing(self):
        for number in (1,2,3):
            self.correlate('UX Lab '+str(number))
            if number<3:self.handle('right','UX Lab '+str(number+1))
        rows=self.observe();self.overview()
        _,nodes=self.nodes();card=exactly_one(nodes,lambda n:label(n)=='Open UX Lab 3','third overview card')
        x1,y1,x2,y2=node_bounds(card)
        self.swipe(((x1+x2)/2,y1+(y2-y1)*.8,(x1+x2)/2,y1+(y2-y1)*.15),120)
        _,nodes=self.wait(lambda ns:any(label(n)=='Close UX Lab 3?' for n in ns),'upward swipe unknown-work confirmation')
        self.tap(exactly_one(nodes,lambda n:n.get('resource-id','').endswith('close-keep-open'),'Keep open default action'))
        self.wait(lambda ns:any(label(n)=='Open UX Lab 3' for n in ns),'kept third card')
        after=self.observe();same_instances(rows,after)
        for key,row in target_map(rows).items():assert_state(row['snapshot'],target_map(after)[key]['snapshot'])
        self.check('swipe-close-keep-open','Actual upward card swipe opened warning; Keep open retained all targets/data')
        remaining=rows
        for number in (3,2,1):
            title='UX Lab '+str(number)
            _,nodes=self.nodes();self.tap(exactly_one(nodes,lambda n:label(n)=='Close '+title,'close '+title))
            self.wait(lambda ns:any(label(n)=='Close '+title+'?' for n in ns),'unknown-work confirmation')
            _,nodes=self.nodes();self.tap(exactly_one(nodes,lambda n:n.get('resource-id','').endswith('close-confirm'),'Close anyway'))
            expected_id=self.bindings[title][0]
            after=self.wait_targets(lambda observed:len(observed)==len(remaining)-1,'exact closed target disappearance')
            if set(target_map(remaining))-set(target_map(after))!={expected_id}:raise CheckFailed('Closing removed the wrong native target')
            for key,row in target_map(after).items():
                if identity(row)!=identity(target_map(remaining)[key]):raise CheckFailed('Closing remounted another session')
                assert_state(target_map(remaining)[key]['snapshot'],row['snapshot'])
            remaining=after
            self.wait(lambda ns:any(label(n)=='Your napplets' for n in ns),'stayed in overview after close')
            self.check('exact-session-closed',{'title':title,'removedTarget':expected_id,'remaining':len(after)})
        _,nodes=self.wait(lambda ns:any(label(n)=='Nothing open' for n in ns),'explicit empty workspace')
        if any(n.get('class')=='android.webkit.WebView' for n in nodes):raise CheckFailed('WebView survives final close')
        self.capture('closed-all-empty')
        self.tap(exactly_one(nodes,lambda n:n.get('resource-id','').endswith('empty-open-napplet'),'empty Open napplet'))
        _,nodes=self.wait(lambda ns:any(n.get('resource-id','').endswith('settings-open-ux-lab') for n in ns),'settings bundled route')
        self.tap(exactly_one(nodes,lambda n:n.get('resource-id','').endswith('settings-open-ux-lab'),'Open UX Lab'))
        self.focused('UX Lab 4');fresh=self.wait_targets(lambda observed:len(observed)==1,'new explicit fixture')
        if fresh[0]['generation'] in {row['generation'] for row in rows} or fresh[0]['snapshot']['counter']!='0' or fresh[0]['snapshot']['draft']!='':
            raise CheckFailed('Explicit reopen did not create a new temporary runtime instance')
        self.check('empty-settings-reopen','Observed Nothing open -> Settings -> Open UX Lab -> fresh generation UX Lab 4')

    def navigation_close(self):
        self.gestures()
        self.closing()

    def card_cancel(self):
        self.correlate('UX Lab 1')
        before = self.observe()
        nodes = self.overview()
        card = exactly_one(nodes, lambda node: label(node) == 'Open UX Lab 1', 'first card')
        bounds = node_bounds(card)
        density = self.adb_run('shell', 'wm', 'density')
        stroke = short_card_stroke(bounds, density)
        self.swipe(stroke['points'], stroke['durationMs'])
        _, nodes = self.wait(lambda observed: any(label(node) == 'Your napplets' for node in observed),
                             'overview retained after short card stroke', timeout=8)
        retained_overview_cards(nodes)
        after = self.observe()
        same_instances(before, after)
        for key, row in target_map(before).items():
            assert_state(row['snapshot'], target_map(after)[key]['snapshot'])
        self.check('short-card-stroke-keeps-overview', {**stroke, 'densityOutput': density,
                   'cardBounds': bounds, 'allStatesRetained': True,
                   'inputScope': 'Requested ADB trajectory; delivered motion samples are not observed'})
        self.capture('short-card-stroke-kept')
        self.open_card('UX Lab 1')
        focused, _ = self.focused('UX Lab 1')
        returned = self.observe()
        same_instances(before, returned)
        visible = target_at_native_bounds(returned, focused['webViewBounds'])
        if identity(visible) != self.bindings['UX Lab 1']:
            raise CheckFailed('Ordinary card tap focused a different native runtime')
        for key, row in target_map(before).items():
            assert_state(row['snapshot'], target_map(returned)[key]['snapshot'])
        self.check('ordinary-card-tap-still-opens', 'Native tap restored the original focused runtime and all fixture states')

    def card_cancel_and_navigation_close(self):
        self.card_cancel()
        self.navigation_close()

    def finish(self):
        self.result['harnessAfter']=self.harness_hashes()
        if self.result['harnessAfter']!=self.result['harnessBefore']:raise CheckFailed('Harness source changed during native evidence run')
        self.result['sourceAfter']=self.source_hashes()
        if self.result['sourceAfter']!=self.result.get('sourceBefore'):raise CheckFailed('Application source changed during native evidence run')
        if self.adb_run('shell','pidof',self.args.package).split()!=[self.pid]:raise CheckFailed('Native app process restarted during scenario')
        self.result['bindings']={title:dict(zip(('targetId','nativeGeneration','frameId','contextUniqueId'),binding)) for title,binding in self.bindings.items()}

    def cleanup(self):
        if self.port:self.adb_run('forward','--remove','tcp:'+self.port,check=False)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True)
    parser.add_argument('--serial',required=True)
    parser.add_argument('--package',default='org.nostrocket.hypergolic.dev')
    parser.add_argument('--adb')
    parser.add_argument('--timeout',type=float,default=30)
    parser.add_argument('--expected-apk-sha256',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--cold-launch',action='store_true',help='Explicitly restart the installed app process; does not reinstall or clear data')
    parser.add_argument('--record-motion',action='store_true',help='Record bounded native MP4 clips around actual handle/card input for later visual review')
    parser.add_argument('scenario',choices=('switch-state','gestures','closing','overview-scroll','navigation-close','card-cancel','card-cancel-and-navigation-close'))
    args=parser.parse_args();args.launch=False
    if not re.fullmatch('[a-f0-9]{64}',args.expected_apk_sha256):parser.error('Exact installed APK SHA-256 required')
    if not re.fullmatch('[A-Za-z0-9_.]+',args.package):parser.error('Invalid package')
    active=None
    exit_code=1
    try:
        active=WorkspaceDriver(args);active.prepare()
        active.result['limitations']=['Debug CDP observations supplement native ADB inputs; numeric Android accessibility remains a separate requirement.',
          'No source mutation, private app API, fixture-state restoration, desktop browser or substituted renderer used.',
          'Standalone release, physical-device behavior and durable restart/storage are not proved. Screenshots require independent visual inspection.']
        {'switch-state':active.switch_state,'gestures':active.gestures,'closing':active.closing,'overview-scroll':active.overview_scroll,'navigation-close':active.navigation_close,'card-cancel':active.card_cancel,
         'card-cancel-and-navigation-close':active.card_cancel_and_navigation_close}[args.scenario]()
        active.finish();active.result['status']='passed';exit_code=0
    except Exception as error:
        if active:
            active.result['status']='failed';active.result['error']=str(error)
            try:active.capture('failure')
            except Exception as capture_error:active.result['captureError']=str(capture_error)
        print('FAILED: '+str(error),file=sys.stderr)
    finally:
        if active:
            if 'sourceBefore' in active.result:
                active.result['sourceAfter']=active.source_hashes()
                active.result['sourceUnchanged']=active.result['sourceAfter']==active.result['sourceBefore']
            try:active.cleanup()
            except Exception as error:active.result['cleanupError']=str(error);active.result['status']='failed';exit_code=1
            active.save();print(json.dumps({'status':active.result['status'],'result':str(active.out/'result.json')}))
    return exit_code

if __name__=='__main__':sys.exit(main())
