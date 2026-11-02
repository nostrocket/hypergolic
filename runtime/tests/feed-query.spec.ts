import { test, expect } from '@playwright/test';
// Native-port double only: proves genuine SDK -> Kehto -> native-client wire and DOM delivery.
for (const mode of ['events', 'empty', 'failure','legacy','archive']) test(`Feed Lab canonical ${mode} through genuine Kehto and native request`, async ({ page }) => {
  await page.addInitScript(mode => {
    if (window !== window.top) return;
    if(mode==='legacy')Object.defineProperty(Object,'hasOwn',{configurable:true,value:undefined});
    const listeners = new Set<(event: {data: string}) => void>();
    (window as any).queryCalls = [];
    (window as any).HypergolicHost = {
      addEventListener: (_: string, listener: (event: {data:string})=>void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: {data:string})=>void) => listeners.delete(listener),
      postMessage: (raw: string) => {
        const message = JSON.parse(raw);
        if (message.type !== 'capability') return;
        const request = JSON.parse(message.message);(window as any).queryCalls.push(request);
        const reply = {type:'relay.query.result',id:request.id,...(mode === 'failure' ? {error:'relay query failed'} : {events:mode === 'empty' ? [] : [{event:{id:'a'.repeat(64),pubkey:'b'.repeat(64),kind:1,created_at:1,tags:[],sig:'c'.repeat(128),content:'Native query wire proof'}}]})};
        const data = JSON.stringify({type:'capability.result',sessionId:message.sessionId,sequence:message.sequence,response:JSON.stringify(reply)});
        for (const listener of listeners) listener({data});
      },
    };
  }, mode);
  await page.goto('/assets/runtime/index.html?sessionId=feed-query-test&fixture='+ (mode==='archive' ? 'feed-lab-v1' : 'feed-lab'));
  const frame=page.frameLocator('#napplet');await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready','true');
  await frame.getByRole('button',{name:'Query notes',exact:true}).click();
  await expect(frame.locator('#status')).toHaveText(mode === 'failure' ? 'Query failed: relay query failed' : mode === 'empty' ? 'Query completed. No matching notes.' : 'Received 1 signed note.');
  const calls=await page.evaluate(()=> (window as any).queryCalls);expect(calls).toHaveLength(1);expect(calls[0]).toEqual({type:'relay.query',id:expect.any(String),filters:[{kinds:[1],limit:8}]});
  if(mode==='events'||mode==='legacy'||mode==='archive')await expect(frame.locator('#events')).toContainText('Native query wire proof');
});

for (const mode of ['events', 'empty', 'failure','legacy','archive']) test(`Feed Lab Outbox canonical ${mode} through genuine Kehto and native request`, async ({ page }) => {
  await page.addInitScript(mode => {
    if (window !== window.top) return;
    if(mode==='legacy')Object.defineProperty(Object,'hasOwn',{configurable:true,value:undefined});
    const listeners = new Set<(event: {data: string}) => void>();
    (window as any).queryCalls = [];
    (window as any).HypergolicHost = {
      addEventListener: (_: string, listener: (event: {data:string})=>void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: {data:string})=>void) => listeners.delete(listener),
      postMessage: (raw: string) => {
        const message = JSON.parse(raw);
        if (message.type !== 'capability') return;
        const request = JSON.parse(message.message);(window as any).queryCalls.push(request);
        const reply = {type:'outbox.query.result',id:request.id,...(mode === 'failure' ? {events:[],error:'relay list unavailable'} : {events:mode === 'empty' ? [] : [{event:{id:'a'.repeat(64),pubkey:'b'.repeat(64),kind:1,created_at:1,tags:[],sig:'c'.repeat(128),content:'Native query wire proof'}}]})};
        const data = JSON.stringify({type:'capability.result',sessionId:message.sessionId,sequence:message.sequence,response:JSON.stringify(reply)});
        for (const listener of listeners) listener({data});
      },
    };
  }, mode);
  await page.goto('/assets/runtime/index.html?sessionId=feed-query-test&domains=identity,outbox,relay,theme&fixture='+ (mode==='archive' ? 'feed-lab-v1' : 'feed-lab'));
  const frame=page.frameLocator('#napplet');await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready','true');
  await frame.getByRole('button',{name:'Query author outbox',exact:true}).click();
  await expect(frame.locator('#outbox-status')).toHaveText(mode === 'failure' ? 'Outbox failed: relay list unavailable' : mode === 'empty' ? 'Outbox received 0 signed events.' : 'Outbox received 1 signed event.');
  const calls=await page.evaluate(()=> (window as any).queryCalls);expect(calls).toHaveLength(1);expect(calls[0]).toEqual({type:'outbox.query',id:expect.any(String),filters:[{kinds:[1],limit:8}]});
  if(mode==='events'||mode==='legacy'||mode==='archive')await expect(frame.locator('#outbox-result')).toContainText('Native query wire proof');
});
