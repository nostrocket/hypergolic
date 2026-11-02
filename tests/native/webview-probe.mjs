#!/usr/bin/env node
/** Diagnostic attachment to the installed Android WebView; never launches Chromium. */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { advancedProbe } from './advanced-probe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireRuntime = createRequire(resolve(root, 'runtime/package.json'));
const { _android: android } = requireRuntime('@playwright/test');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]]);
  return pairs;
}, []));
const output = { schemaVersion: 1, status: 'running', mode: args.mode ?? 'boundary',
  scope: 'Actual Android debug WebView, evaluated only inside existing untrusted frame', checks: [] };
let device;
try {
  const devices = await android.devices({ omitDriverInstall: true });
  device = devices.find(item => item.serial() === args.serial);
  assert(device, 'Explicit Android target unavailable to Playwright');
  device.setDefaultTimeout(12_000);
  const webview = await device.webView({ pkg: args.package });
  const page = await webview.page();
  page.setDefaultTimeout(8000);
  const host = new URL(page.url());
  assert.equal(host.origin, 'https://appassets.androidplatform.net');
  assert.equal(host.pathname, '/assets/runtime/index.html');
  const frames = page.frames().filter(frame => frame.parentFrame() === page.mainFrame());
  assert.equal(frames.length, 1, 'Expected exactly one existing child frame');
  const frame = frames[0];
  assert.equal(frame.url(), 'about:srcdoc');
  output.target = { package: webview.pkg(), pid: webview.pid(), host: host.origin + host.pathname, frame: frame.url() };
  const snapshot = async () => frame.evaluate(() => {
    const get = id => document.getElementById(id);
    const bounds = id => { const r = get(id)?.getBoundingClientRect(); return r ? { x:r.x,y:r.y,width:r.width,height:r.height } : null; };
    return { ready:get('ready')?.textContent, theme:get('theme-status')?.textContent,
      counter:get('counter')?.textContent, draft:get('draft')?.value, mirror:get('draft-mirror')?.textContent,
      viewport:{width:innerWidth,height:innerHeight}, scroll:{x:scrollX,y:scrollY},
      controls:{increment:bounds('increment'),draft:bounds('draft')},
      runtimeDomains:Object.keys(window.napplet ?? {}) };
  });
  output.snapshot = await snapshot();
  assert(output.snapshot.ready?.startsWith('Ready ·'), 'Fixture not ready in actual WebView');
  assert.equal(output.snapshot.theme, 'Host colors', 'Real host theme did not arrive');
  assert.deepEqual(output.snapshot.runtimeDomains.sort(), ['shell','theme']);
  if (output.mode === 'snapshot') {
    output.status = 'passed';
  } else if (['network-receiver','navigation-surfaces','self-navigation','diagnostic-rejections','diagnostic-control'].includes(output.mode)) {
    await advancedProbe({page,frame,snapshot,mode:output.mode,args,output});
  } else if (output.mode === 'renderer-loss') {
    output.scope = 'Targeted actual Android WebView Page.crash; no trusted-host evaluation or broad process kill';
    const cdp = await page.context().newCDPSession(page);
    let command = {state:'pending'};
    let observed;
    const loss = new Promise(resolve => {
      page.once('crash', () => { observed='crash'; resolve('crash'); });
      page.once('close', () => { observed ??= 'close'; resolve(observed); });
    });
    // Some WebViews destroy the target before replying; failure alone is not proof.
    void cdp.send('Page.crash').then(() => {command={state:'returned'};},
      error => {command={state:'rejected',error:String(error)};});
    let timer;
    try {
      await Promise.race([loss,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('No actual page crash/close observed after Page.crash')),8000);
      })]);
    } finally { clearTimeout(timer); }
    output.rendererLoss = {method:'Page.crash',observed,command,pageClosed:page.isClosed()};
    output.checks.push({name:'targeted-renderer-loss-observed',result:output.rendererLoss});
    output.unproven=['This diagnostic proves only crash/close observation. The Python driver independently requires native renderer-stopped, removed WebView, surviving app process and absent executable target.'];
    output.status='passed';
  } else {
    assert.equal(output.mode,'boundary','Unsupported probe mode');
    // Do not evaluate on page/mainFrame, replace host bridge or change policies.
    const access = await frame.evaluate(async () => {
      const blocked={};
      for (const [name,read] of Object.entries({ parentDom:()=>parent.document.body,
        parentBridge:()=>parent.HypergolicHost, localStorage:()=>localStorage.length,
        sessionStorage:()=>sessionStorage.length, indexedDB:()=>indexedDB.open('native-probe') })) {
        try { read(); blocked[name]=false; } catch { blocked[name]=true; }
      }
      const environment=await window.napplet.shell.ready();
      return {blocked, ownBridge:typeof window.HypergolicHost,
        legacyBridge:typeof window.ReactNativeWebView, signer:typeof window.nostr,environment};
    });
    assert(Object.values(access.blocked).every(value=>value===true));
    assert.equal(access.ownBridge,'undefined'); assert.equal(access.legacyBridge,'undefined'); assert.equal(access.signer,'undefined');
    assert.deepEqual(access.environment,{capabilities:{domains:['theme']},services:['theme']});
    output.checks.push({name:'native-object-and-storage-denial',result:access});
    const envelopes = await frame.evaluate(async () => {
      const messages=[];
      const receive=event=>messages.push(event.data);
      addEventListener('message',receive);
      const barrier='native-probe-barrier-'+Date.now();
      try {
        const waited=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{removeEventListener('message',end);reject(new Error('Allowed theme barrier timed out'));},5000);
          const end=event=>{if(event.data?.id===barrier){clearTimeout(timer);removeEventListener('message',end);resolve();}};
          addEventListener('message',end);
        });
        for(const data of [null,[], 'shell.ready',{type:'shell.ready',capabilities:['relay']},
          {type:'theme.get',id:'invalid-extra',authority:'forged'},{type:'theme.get',id:'x'.repeat(129)},
          {type:'relay.publish',id:'denied-relay',event:{kind:1,content:'Must not publish'}},
          {type:'storage.set',id:'denied-storage',key:'x',value:'y'},
          {type:'shell.supports',id:'denied-supports'},{type:'shell.ready'},{type:'shell.ready'}]) parent.postMessage(data,'*');
        parent.postMessage({type:'theme.get',id:barrier},'*');
        await waited;
        return {responses:messages, barrier};
      } finally { removeEventListener('message',receive); }
    });
    assert.equal(envelopes.responses.filter(m=>m?.type==='shell.init').length,0,'Duplicate ready reinitialized');
    assert(!envelopes.responses.some(m=>['invalid-extra','denied-relay','denied-storage','denied-supports'].includes(m?.id)));
    assert(envelopes.responses.some(m=>m?.id===envelopes.barrier && m.type==='theme.get.result'));
    output.checks.push({name:'unsupported-malformed-and-duplicate-ready',result:envelopes});
    const network=await frame.evaluate(async()=>{
      const denied={},violations=[];
      const observe=event=>violations.push({directive:event.effectiveDirective,blockedURI:event.blockedURI});
      addEventListener('securitypolicyviolation',observe);
      const bounded=(name,fn)=>Promise.race([fn(),new Promise((_,reject)=>setTimeout(()=>reject(new Error(name+' no definitive browser result')),4000))]);
      try {
        try{await fetch('https://example.invalid/native-fetch');denied.fetch=false;}catch{denied.fetch=true;}
        denied.socket=await bounded('socket',()=>new Promise(resolve=>{try{const ws=new WebSocket('wss://example.invalid/native-socket');ws.onopen=()=>{ws.close();resolve(false)};ws.onerror=()=>resolve(true);}catch{resolve(true)}}));
        denied.image=await bounded('image',()=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(false);image.onerror=()=>resolve(true);image.src='https://example.invalid/native-image';}));
        denied.script=await bounded('script',()=>new Promise(resolve=>{const script=document.createElement('script');script.onload=()=>{script.remove();resolve(false)};script.onerror=()=>{script.remove();resolve(true)};script.src='https://example.invalid/native-script';document.head.append(script);}));
        const blob=URL.createObjectURL(new Blob(['postMessage(1)'],{type:'text/javascript'}));
        try{denied.worker=await bounded('worker',()=>new Promise(resolve=>{try{const worker=new Worker(blob);worker.onmessage=()=>{worker.terminate();resolve(false)};worker.onerror=e=>{e.preventDefault();worker.terminate();resolve(true)};}catch{resolve(true)}}));}finally{URL.revokeObjectURL(blob)}
        try{top.location.href='https://example.invalid/native-top';denied.topNavigation=false;}catch{denied.topNavigation=true;}
        return {denied,violations};
      } finally{removeEventListener('securitypolicyviolation',observe)}
    });
    output.checks.push({name:'actual-webview-network-observation',result:network});
    assert(Object.values(network.denied).every(value=>value===true));
    for(const directive of ['connect-src','img-src']) assert(network.violations.some(v=>v.directive===directive),'No actual CSP violation for '+directive);
    assert.equal(new URL(page.url()).pathname,'/assets/runtime/index.html');
    output.checks.push({name:'actual-webview-csp-and-top-navigation',result:'fetch/socket/image/script/worker denied; connect-src and img-src violations observed; worker may be rejected earlier by opaque-origin enforcement'});
    output.snapshotAfter = await snapshot();
    assert.equal(output.snapshotAfter.counter,output.snapshot.counter);
    assert.equal(output.snapshotAfter.draft,output.snapshot.draft);
    output.unproven=[
      'Diagnostic debug-WebView injection is supplementary; repeat essential boundary behavior with unmodified hostile artifact in release/instrumentation.',
      'Network denial observed through definitive errors and actual CSP violations; independent receiver-side no-egress observation is not yet implemented.',
      'Pre-readiness traffic, unregistered sibling source, direct forged native callback origin/main-frame/generation, oversized native diagnostics, rate limits, renderer crash and teardown/replay remain unproven on Android.',
      'File/content URLs, nested navigation, popup/download/media/chooser/SSL/cookie enforcement remain unproven on Android.',
      'No identity, signing, storage capability, published loading, physical device or complete v1 acceptance is claimed.',
      'Android accessibility tree may omit WebView descendants; CDP DOM observations do not establish screen-reader accessibility.'
    ];
    output.status='passed';
  }
} catch(error) {
  output.status='failed'; output.error=String(error); process.exitCode=1;
} finally {
  // Closing the diagnostic connection does not force-stop or navigate the app.
  await device?.close().catch(()=>{});
  if(args.output) writeFileSync(args.output,JSON.stringify(output,null,2)+'\n');
  process.stdout.write(JSON.stringify(output)+'\n');
}
