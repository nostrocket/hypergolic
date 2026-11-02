import { identity, outbox, relay, type NostrFilter } from '@napplet/sdk';
import './style.css';
function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing fixture control');
  return value as T;
}
const lab = element('lab'), status = element('status'), events = element<HTMLOListElement>('events');
const filters = element<HTMLTextAreaElement>('filters'), query = element<HTMLButtonElement>('query'), empty = element<HTMLButtonElement>('empty');
const start = element<HTMLButtonElement>('subscribe'), close = element<HTMLButtonElement>('close'), streamStatus = element('stream-status');
let subscription: ReturnType<typeof relay.subscribe> | null = null;
let streamCount = 0, eose = false;
const recentIds = new Set<string>();
const outboxButton = element<HTMLButtonElement>('outbox-query'), outboxStatus = element('outbox-status'), outboxResult = element('outbox-result');
const outboxReadButtons = ['outbox-event','outbox-resolve-read','outbox-resolve-write'].map(id => element<HTMLButtonElement>(id));
const outboxStart=element<HTMLButtonElement>('outbox-start'),outboxClose=element<HTMLButtonElement>('outbox-close'),outboxStreamStatus=element('outbox-stream-status'),outboxOptions=element<HTMLTextAreaElement>('outbox-options');
const outboxPublish=element<HTMLButtonElement>('outbox-publish'),outboxPublishOptions=element<HTMLTextAreaElement>('outbox-publish-options'),outboxPublishStatus=element('outbox-publish-status'),outboxPublishResult=element('outbox-publish-result');
let publicationPending=false;
const outboxWireTypes=new Set<string>();
window.addEventListener('message',event=>{if(event.source===parent&&typeof event.data?.type==='string'&&event.data.type.startsWith('outbox.')&&event.data.type.length<=128&&outboxWireTypes.size<32)outboxWireTypes.add(event.data.type);});
let outboxStream:ReturnType<typeof outbox.subscribe>|null=null,outboxCount=0;
let outboxPending = false;
let disposed = false, busy = false, ready = false;
function controls(): void {
  outboxPublish.disabled=!ready||disposed||publicationPending;
  query.disabled = empty.disabled = !ready || busy || disposed || subscription !== null;
  start.disabled = !ready || busy || disposed || subscription !== null;
  close.disabled = subscription === null || disposed;
  outboxButton.disabled = !ready || disposed || outboxPending;
  for (const button of outboxReadButtons) button.disabled = outboxButton.disabled;
  outboxStart.disabled = !ready || disposed || outboxPending || outboxStream !== null;outboxClose.disabled = disposed || outboxStream === null;
}
function read(): void {
  if (busy || disposed || !ready) return;
  busy = true; controls(); events.replaceChildren(); status.textContent = 'Reading notes…'; lab.dataset.state = 'loading';
  try {
    const input: unknown = JSON.parse(filters.value);
    if (!Array.isArray(input) || input.length < 1 || input.length > 4 || !input.every(value => value && typeof value === 'object' && !Array.isArray(value))) throw new Error('Enter a list of query filters.');
    void relay.query(input as NostrFilter[]).then(result => {
    if (disposed) return;
    if (!Array.isArray(result) || result.length > 32) throw new Error('Invalid query result.');
    for (const { event } of result) {
      if (!event || typeof event.content !== 'string' || typeof event.id !== 'string') throw new Error('Invalid event result.');
      const row = document.createElement('li'), content = document.createElement('p'), id = document.createElement('code');
      content.textContent = event.content; id.textContent = event.id; row.append(content, id); events.append(row);
    }
    lab.dataset.state = result.length ? 'success' : 'empty';
    status.textContent = result.length ? `Received ${result.length} signed note${result.length === 1 ? '' : 's'}.` : 'Query completed. No matching notes.';
    }).catch(failure).finally(() => { busy = false; controls(); });
  } catch (error) { failure(error); busy = false; controls(); }
}
function failure(error: unknown): void {
  if (disposed) return;
  events.replaceChildren(); lab.dataset.state = 'error';
  status.textContent = `Query failed: ${error instanceof Error ? error.message : 'unavailable'}`;
}
function liveStatus(): void {
  streamStatus.textContent = `Live · ${streamCount} signed note${streamCount === 1 ? '' : 's'}${eose ? ' · history loaded' : ' · loading history'}.`;
}
function stopLive(): void {
  const current = subscription; subscription = null; current?.close();
  streamStatus.textContent = 'Live feed closed.'; lab.dataset.stream = 'closed'; controls();
}
start.addEventListener('click', () => {
  if (disposed || busy || !ready || subscription) return;
  try {
    const input: unknown = JSON.parse(filters.value);
    if (!Array.isArray(input) || input.length < 1 || input.length > 4 || !input.every(value => value && typeof value === 'object' && !Array.isArray(value))) throw new Error('Enter a list of note filters.');
    events.replaceChildren(); recentIds.clear(); streamCount = 0; eose = false; liveStatus(); lab.dataset.stream = 'open';
    subscription = relay.subscribe(input as NostrFilter[], ({ event }) => {
      if (disposed || !subscription || recentIds.has(event.id)) return;
      if (typeof event.content !== 'string' || typeof event.id !== 'string') { stopLive(); return; }
      const row = document.createElement('li'), content = document.createElement('p'), id = document.createElement('code');
      row.dataset.eventId = event.id; content.textContent = event.content; id.textContent = event.id; row.append(content, id); events.prepend(row);
      recentIds.add(event.id); streamCount++;
      if (events.children.length > 32) { const last = events.lastElementChild as HTMLElement; recentIds.delete(last.dataset.eventId!); last.remove(); }
      if (streamCount >= Number.MAX_SAFE_INTEGER) { stopLive(); return; }
      liveStatus();
    }, () => { if (!disposed && subscription) { eose = true; liveStatus(); } });
    controls();
  } catch (error) { stopLive(); streamStatus.textContent = `Live feed failed: ${error instanceof Error ? error.message : 'unavailable'}`; }
});
close.addEventListener('click', stopLive);
// The SDK handle has no terminal callback. The captured parent is the sole shell sender.
window.addEventListener('message', event => {
  if (event.source !== parent || !subscription || event.data?.type !== 'relay.closed') return;
  subscription = null; lab.dataset.stream = 'closed';
  streamStatus.textContent = `Live feed closed: ${typeof event.data.reason === 'string' ? event.data.reason : 'unavailable'}`; controls();
});
query.addEventListener('click', () => { void read(); });
empty.addEventListener('click', () => { filters.value = '[{"kinds":[1],"limit":0}]'; void read(); });
window.addEventListener('pagehide', () => { stopLive(); disposed = true; controls(); }, { once: true });
controls();
ready = true; lab.dataset.ready = 'true'; status.textContent = 'Ready to query.'; controls();

const followsButton = element<HTMLButtonElement>('follows');
const followsResult = element('follows-result'), followsStatus = element('follows-status');
let followsPending = false, identityEpoch = 0;
function clearFollows(): void {publicationPending=false;outboxPublishResult.textContent='';outboxPublishStatus.textContent='No publication requested.';stopOutbox();outboxPending = false; outboxResult.textContent = ''; outboxStatus.textContent = 'No Outbox query yet.'; controls(); identityEpoch++; followsPending = false; followsButton.disabled = disposed; followsResult.textContent = ''; followsStatus.textContent = 'No follows request yet.';}
try {const changes = identity.onChanged(clearFollows); window.addEventListener('pagehide', () => {identityEpoch++; followsButton.disabled = true; changes.close();}, {once: true});} catch { /* Query and stream controls still work when this optional domain is unavailable. */ }
followsButton.addEventListener('click', () => {
  if (disposed || followsPending) return;
  const epoch = identityEpoch, current = () => !disposed && epoch === identityEpoch;
  followsPending = true; followsButton.disabled = true; followsStatus.textContent = 'Reading public follows…';
  void identity.getFollows().then(pubkeys => {
    if (!current()) return;
    followsResult.textContent = JSON.stringify(pubkeys); followsStatus.textContent = 'Follows read complete.';
  }).catch(error => {if (current()) {followsResult.textContent = ''; followsStatus.textContent = 'Follows read failed: ' + (error instanceof Error ? error.message.slice(0, 240) : 'identity unavailable');}})
    .finally(() => {if (current()) {followsPending = false; followsButton.disabled = false;}});
});

outboxButton.addEventListener('click', () => {
  if (!ready || disposed || outboxPending) return;
  const epoch = identityEpoch, current = () => !disposed && epoch === identityEpoch;
  outboxPending = true; controls(); outboxResult.textContent = '';
  outboxStatus.textContent = 'Resolving author write relays…'; lab.dataset.outbox = 'loading';
  const fail = (error: unknown) => {if (current()) {outboxStatus.textContent = `Outbox failed: ${error instanceof Error ? error.message : 'unavailable'}`; lab.dataset.outbox = 'error';}};
  const finish = () => {if (current()) {outboxPending = false; controls();}};
  try {
    const input: unknown = JSON.parse(filters.value);
    if (!Array.isArray(input)) throw Error('Enter a list of query filters.');
    const options=JSON.parse(outboxOptions.value);
    void outbox.query(input as NostrFilter[],Object.keys(options).length ? options : undefined).then(result => {
      if (!current()) return;
      outboxResult.textContent = JSON.stringify(result);
      if (result.error) throw Error(result.error);
      outboxStatus.textContent = `Outbox received ${result.events.length} signed event${result.events.length === 1 ? '' : 's'}${result.incomplete ? ' · incomplete' : ''}.`;
      lab.dataset.outbox = 'success';
    }).catch(fail).finally(finish);
  } catch (error) {fail(error); finish();}
});

for (const button of outboxReadButtons) button.addEventListener('click', () => {
  if (!ready || disposed || outboxPending) return;
  const epoch = identityEpoch, current = () => !disposed && epoch === identityEpoch;
  outboxPending = true; controls(); outboxResult.textContent = ''; outboxStatus.textContent = 'Resolving Outbox read…';
  void (async () => {
    const input: unknown = JSON.parse(filters.value);
    if (!Array.isArray(input) || input.length !== 1 || !input[0] || typeof input[0] !== 'object') throw Error('Enter one filter with the target author or event ID.');
    const filter = input[0] as {authors?: string[]; ids?: string[]};
    if (button.id === 'outbox-event') {
      if (filter.ids?.length !== 1) throw Error('Enter one event ID in the filter.');
      return outbox.getEvent(filter.ids[0]!, filter.authors?.length === 1 ? {author:filter.authors[0]} : {});
    }
    if (!filter.authors?.length) throw Error('Enter target authors in the filter.');
    return outbox.resolveRelays({authors:filter.authors,direction:button.id === 'outbox-resolve-write' ? 'write' : 'read'});
  })().then(result => {
    if (!current()) return;
    outboxResult.textContent = JSON.stringify(result);
    if ('error' in result && result.error) throw Error(result.error);
    outboxStatus.textContent = button.id === 'outbox-event' ? 'Outbox event read complete.' : 'Outbox relay plan resolved.';
    lab.dataset.outbox = 'success';
  }).catch(error => {
    if (current()) {outboxStatus.textContent = `Outbox failed: ${error instanceof Error ? error.message : 'unavailable'}`;lab.dataset.outbox = 'error';}
  }).finally(() => {if (current()) {outboxPending = false;controls();}});
});

function stopOutbox():void {
  const current=outboxStream;outboxStream=null;current?.close();outboxStreamStatus.textContent='Live Outbox closed.';controls();
}
outboxStart.addEventListener('click',()=> {
  if(!ready||disposed||outboxPending||outboxStream)return;
  const epoch=identityEpoch,events:unknown[]=[];outboxCount=0;outboxResult.textContent='';
  try {
    const input=JSON.parse(filters.value),options=JSON.parse(outboxOptions.value);
    outboxStream=outbox.subscribe(input,Object.keys(options).length ? options : undefined);
    outboxStream.on('event',result=> {
      if(disposed||!outboxStream||identityEpoch!==epoch)return;
      events.push(result);if(events.length>4)events.shift();outboxCount++;
      outboxResult.textContent=JSON.stringify({events,count:outboxCount,wireTypes:[...outboxWireTypes]});
      outboxStreamStatus.textContent=`Live Outbox · ${outboxCount} signed event${outboxCount===1?'':'s'}.`;
    });
    outboxStream.on('closed',reason=> {
      if(disposed||identityEpoch!==epoch)return;outboxStream=null;outboxStreamStatus.textContent=`Live Outbox closed: ${reason ?? 'unavailable'}`;controls();
    });
    outboxStreamStatus.textContent='Live Outbox connecting…';controls();
  } catch(error) {stopOutbox();outboxStreamStatus.textContent=`Live Outbox failed: ${error instanceof Error ? error.message : 'unavailable'}`;}
});
outboxClose.addEventListener('click',stopOutbox);
window.addEventListener('pagehide',stopOutbox,{once:true});

outboxPublish.addEventListener('click',()=> {
  if(!ready||disposed||publicationPending)return;
  const epoch=identityEpoch,current=()=>!disposed&&epoch===identityEpoch;
  publicationPending=true;controls();outboxPublishResult.textContent='';outboxPublishStatus.textContent='Waiting for shell review…';
  const fail=(error:unknown)=>{if(current())outboxPublishStatus.textContent='Publication failed: '+(error instanceof Error?error.message:'unavailable');};
  const finish=()=>{if(current()){publicationPending=false;controls();}};
  try {
    const content=element<HTMLTextAreaElement>('draft').value;
    if(!content.trim())throw Error('Write a draft before requesting publication.');
    const options=JSON.parse(outboxPublishOptions.value);
    void outbox.publish({kind:1,content,tags:[],created_at:Math.floor(Date.now()/1000)},options).then(result=> {
      if(!current())return;
      outboxPublishResult.textContent=JSON.stringify(result);
      outboxPublishStatus.textContent=result.ok?'Primary event accepted. See the shell for per-relay and relay-list results.':'Publication failed: '+(result.error??'no relay acceptance');
    }).catch(fail).finally(finish);
  } catch(error){fail(error);finish();}
});
