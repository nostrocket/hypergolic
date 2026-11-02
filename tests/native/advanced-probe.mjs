/** Additional actual-device observations. Every authority level is explicit. */
import assert from 'node:assert/strict';

export async function advancedProbe({ page, frame, snapshot, mode, args, output }) {
  if (mode === 'network-receiver') {
    assert.match(args.endpoint ?? '', /^http:\/\/127\.0\.0\.1:\d+\/attempt\/[a-f0-9]{24}$/);
    output.scope = 'Existing untrusted Android WebView frame; independent receiver supplied by native driver';
    output.network = await frame.evaluate(async base => {
      const violations=[];
      const onViolation=event=>violations.push({directive:event.effectiveDirective,blockedURI:event.blockedURI});
      addEventListener('securitypolicyviolation',onViolation);
      const bounded=(name,promise)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(name+' lacked definitive outcome')),3500))]);
      const result={};
      try {
        try { await fetch(base+'/fetch'); result.fetch='loaded'; } catch(error) { result.fetch=String(error); }
        result.websocket=await bounded('websocket',new Promise(resolve=>{
          try { const socket=new WebSocket(base.replace('http:','ws:')+'/websocket');
            socket.onopen=()=>{socket.close();resolve('opened')};socket.onerror=()=>resolve('error');
          } catch(error) {resolve(String(error))}
        }));
        result.image=await bounded('image',new Promise(resolve=>{
          const image=new Image();image.onload=()=>resolve('loaded');image.onerror=()=>resolve('error');image.src=base+'/image';
        }));
        result.script=await bounded('script',new Promise(resolve=>{
          const script=document.createElement('script');script.onload=()=>{script.remove();resolve('loaded')};script.onerror=()=>{script.remove();resolve('error')};script.src=base+'/script';document.head.append(script);
        }));
        // A final real allowed reply establishes continued frame/host operation.
        const theme=await window.napplet.theme.get();
        return {result,violations,continuedTheme:theme};
      } finally { removeEventListener('securitypolicyviolation',onViolation); }
    },args.endpoint);
    assert(Object.values(output.network.result).every(value=>!['loaded','opened'].includes(value)));
    assert(output.network.violations.some(value=>value.directive==='connect-src'));
    assert(output.network.violations.some(value=>value.directive==='img-src'));
    assert(output.network.continuedTheme.colors);
    output.checks.push({name:'untrusted-network-attempts',result:output.network});
    output.unproven=['Independent receiver silence and positive controls must be verified by driver.py; this JS result alone cannot prove no receipt.','HTTP/WS localhost is a scoped transport target. CSP, mixed-content and native network layers are not bypassed or isolated from one another.'];
    output.status='passed';
    return;
  }
  if (mode === 'navigation-surfaces') {
    output.scope='Navigation attempts from existing opaque napplet frame only';
    const logs=[];
    const onConsole=message=>{if(message.type()==='error') logs.push(message.text().slice(0,700));};
    page.on('console',onConsole);
    try {
      output.navigation=await frame.evaluate(async()=>{
        const violations=[],results={};
        const onViolation=e=>violations.push({directive:e.effectiveDirective,blockedURI:e.blockedURI});
        addEventListener('securitypolicyviolation',onViolation);
        try {
          for(const [name,url] of [['file','file:///sdcard/hypergolic-nonexistent-probe'],['content','content://org.nostrocket.invalid/hypergolic-nonexistent-probe']]) {
            try { await fetch(url);results[name+'Fetch']='loaded'; } catch(error) { results[name+'Fetch']=String(error); }
          }
          const nested=[];
          for(const [name,url] of [['https','https://example.invalid/native-child'],['file','file:///sdcard/hypergolic-nonexistent-probe'],['content','content://org.nostrocket.invalid/hypergolic-nonexistent-probe']]) {
            const iframe=document.createElement('iframe');
            const events=[];iframe.onload=()=>events.push('load');iframe.onerror=()=>events.push('error');
            iframe.src=url;document.body.append(iframe);nested.push({name,iframe,events});
          }
          try { const popup=open('https://example.invalid/native-popup','_blank');results.popup=popup===null?'null':'window';popup?.close(); } catch(error) {results.popup=String(error)}
          // Real asynchronous theme reply is a barrier, not a fabricated timeout result.
          await window.napplet.theme.get();
          results.nested=nested.map(({name,iframe,events})=>{let doc;try{doc=iframe.contentDocument?.URL??null}catch(error){doc=String(error)}return{name,events,urlAttribute:iframe.src,readableDocument:doc};});
          for(const {iframe} of nested) iframe.remove();
          return {results,violations};
        } finally {removeEventListener('securitypolicyviolation',onViolation)}
      });
      output.navigation.consoleErrors=logs;
      assert.notEqual(output.navigation.results.fileFetch,'loaded');
      assert.notEqual(output.navigation.results.contentFetch,'loaded');
      assert.notEqual(output.navigation.results.popup,'window');
      assert(output.navigation.violations.some(value=>value.directive==='frame-src'));
      output.snapshotAfter=await snapshot();
      assert.equal(output.snapshotAfter.theme,'Host colors');
      assert.equal(output.snapshotAfter.counter,output.snapshot.counter);
      output.checks.push({name:'file-content-nested-frame-popup-observation',result:output.navigation});
      output.unproven=['File/content fetch and nested frame attempts are denied without reading real files/providers. These observations do not isolate native access settings from CSP.','Nested iframe load events may fire for a blocked document; URL attributes and load events are not treated as successful document execution.','Self-navigation is a separate destructive scenario; user-gesture popup variants and actual SSL/download/chooser paths remain unproven.'];
      output.status='passed';
    } finally {page.off('console',onConsole)}
    return;
  }
  if (mode === 'self-navigation') {
    output.scope='Existing untrusted frame navigates itself to about:blank; no trusted-host injection';
    const loss = new Promise(resolve=>page.once('close',()=>resolve('page-closed')));
    let timer;
    const attempt=frame.evaluate(()=>{location.href='about:blank';}).then(()=>({state:'returned'}),error=>({state:'rejected',error:String(error)}));
    output.navigationAttempt=await attempt;
    try {
      output.observed=await Promise.race([loss,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('Self-navigation did not cause observed target destruction')),8000);
      })]);
    } finally {clearTimeout(timer)}
    output.checks.push({name:'actual-self-navigation-target-closed',result:output.observed});
    output.unproven=['Python driver must independently verify native frame-navigation error, removed view and absent executable target.'];
    output.status='passed';
    return;
  }
  if (mode === 'diagnostic-rejections') {
    output.scope='Explicit trusted-host fault injection through the actual AndroidX WebMessageListener; not a napplet authority proof';
    // This is the only mode that evaluates on the trusted document. It neither
    // adds an API nor replaces the existing listener, origin, policies or bridge.
    output.diagnostics=await page.evaluate(()=>{
      const sessionId=new URL(location.href).searchParams.get('sessionId');
      const encode=value=>JSON.stringify(value);
      const values=[
        {name:'wrong-generation',text:encode({type:'error',sessionId:'wrong-generation',code:'wrong-generation-probe'})},
        {name:'malformed-json',text:'{not-json'},
        {name:'array',text:'[]'},
        {name:'extra-field',text:encode({type:'error',sessionId,code:'extra-field-probe',authority:'forged'})},
        {name:'invalid-code',text:encode({type:'error',sessionId,code:'INVALID CODE'})},
        {name:'unsupported-type',text:encode({type:'unsupported',sessionId})},
        {name:'oversized-valid-json',text:' '.repeat(2100)+encode({type:'error',sessionId,code:'oversized-probe'})},
      ];
      for(const value of values) window.HypergolicHost.postMessage(value.text);
      return values.map(({name,text})=>({name,bytes:new TextEncoder().encode(text).byteLength}));
    });
    output.snapshotAfter=await snapshot();
    assert.equal(output.snapshotAfter.theme,'Host colors');
    // Actual allowed theme operation after injection; no native result is faked.
    assert((await frame.evaluate(()=>window.napplet.theme.get())).colors);
    output.checks.push({name:'trusted-host-invalid-diagnostics-sent',result:output.diagnostics});
    output.unproven=['Native continued readiness is independently observed by driver.py. This mode does not forge origin/isMainFrame or establish access from an untrusted frame.','Native listener does not acknowledge denied messages. Positive valid-error control is a separate destructive scenario.'];
    output.status='passed';
    return;
  }
  if (mode === 'diagnostic-control') {
    output.scope='Explicit trusted-host positive fault control through actual AndroidX WebMessageListener';
    const loss=new Promise(resolve=>page.once('close',()=>resolve('page-closed')));
    let timer;
    output.controlAttempt=await page.evaluate(()=>{
      const sessionId=new URL(location.href).searchParams.get('sessionId');
      window.HypergolicHost.postMessage(JSON.stringify({type:'error',sessionId,code:'diagnostic-probe'}));
    }).then(()=>({state:'returned'}),error=>({state:'rejected',error:String(error)}));
    try {output.observed=await Promise.race([loss,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Valid diagnostic did not close target')),8000)})]);}
    finally {clearTimeout(timer)}
    output.checks.push({name:'valid-diagnostic-target-closed',result:output.observed});
    output.unproven=['Python driver must independently verify native diagnostic-probe error, removed WebView, unchanged app process and absent executable target.'];
    output.status='passed';
    return;
  }
  throw new Error('Unsupported advanced probe mode: '+mode);
}
