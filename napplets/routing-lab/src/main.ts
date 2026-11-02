import {intent,inc,storage,notify,config} from '@napplet/sdk';
import './style.css';
function element<T extends HTMLElement>(id: string): T {const value = document.getElementById(id); if (!value) throw new Error('Missing fixture control'); return value as T;}
const text = (id: string, value: unknown) => {element(id).textContent = typeof value === 'string' ? value : JSON.stringify(value);};
const input = (id: string) => element<HTMLInputElement>(id).value;
const payload = () => JSON.parse(element<HTMLTextAreaElement>('payload').value) as unknown;
const button = (id: string, action: () => void) => element<HTMLButtonElement>(id).addEventListener('click', action);
let disposed = false;
const channels: ReturnType<typeof inc.channel.onOpened>[] = [];
let topic: ReturnType<typeof inc.on> | null = null;
let channel: Awaited<ReturnType<typeof inc.channel.open>> | null = null;
const topicEvents: unknown[] = [], channelEvents: unknown[] = [];
function record(rows: unknown[], id: string, value: unknown) {if (rows.length === 16) rows.shift(); rows.push(value); text(id, rows);}
function failure(id: string, error: unknown) {if (!disposed) text(id, 'Request failed: ' + (error instanceof Error ? error.message.slice(0, 256) : 'unavailable'));}
let changes: ReturnType<typeof intent.onChanged> | null = null;
try {changes = intent.onChanged(value => {if (!disposed) text('changed', value);});} catch {text('changed', 'Intent domain unavailable.');}
button('available', () => {void Promise.resolve().then(() => intent.available(input('archetype'))).then(value => {if (!disposed) text('availability', value);}).catch(error => failure('intent-status', error));});
button('handlers', () => {void Promise.resolve().then(() => intent.handlers()).then(value => {if (!disposed) text('availability', value);}).catch(error => failure('intent-status', error));});
button('invoke', () => {
  try {
    const request = {archetype: input('archetype'), action: input('action'), convention: input('convention'), payload: payload(), handler: input('handler'), behavior: {focus: !element<HTMLInputElement>('keep-focus').checked, newWindow: element<HTMLInputElement>('new-instance').checked}};
    text('intent-status', 'Awaiting dispatch review…'); text('intent-result', '');
    void intent.invoke(request).then(value => {if (!disposed) {text('intent-result', value); text('intent-status', value.ok ? 'Dispatch accepted.' : 'Dispatch declined.');}}).catch(error => failure('intent-status', error));
  } catch (error) {failure('intent-status', error);}
});
function subscribeTopic() {
  try {topic?.close(); topic = inc.on(input('topic'), event => {if (!disposed) {record(topicEvents, 'topic-events', event); text('topic-status', 'Received topic message.');}}); text('topic-status', 'Topic approval requested.');}
  catch (error) {failure('topic-status', error);}
}
button('subscribe', subscribeTopic);
button('unsubscribe', () => {topic?.close(); topic = null; text('topic-status', 'Topic subscription closed.');});
button('emit', () => {try {inc.emit(input('topic'), payload()); text('topic-status', 'Topic emission sent.');} catch (error) {failure('topic-status', error);}});
function bindChannel(value: Awaited<ReturnType<typeof inc.channel.open>>) {
  channel = value; text('channel-info', {id: value.id, peer: value.peer}); text('channel-status', 'Channel opened.');
  value.on(event => {if (!disposed) record(channelEvents, 'channel-events', event);});
  value.onClosed(record => {if (!disposed) {text('channel-closed', record); text('channel-status', 'Channel closed.');}});
}
try {channels.push(inc.channel.onOpened(value => {if (!disposed) bindChannel(value);}));} catch {text('channel-status', 'INC domain unavailable.');}
button('open-channel', () => {text('channel-status', 'Awaiting channel review…'); void Promise.resolve().then(() => inc.channel.open(input('peer'))).then(value => {if (!disposed) bindChannel(value);}).catch(error => failure('channel-status', error));});
button('list-channels', () => {void Promise.resolve().then(() => inc.channel.list()).then(value => {if (!disposed) text('channel-info', value);}).catch(error => failure('channel-status', error));});
button('channel-emit', () => {try {if (!channel) throw Error('No channel'); channel.emit(payload());} catch (error) {failure('channel-status', error);}});
button('broadcast', () => {try {inc.channel.broadcast(payload());} catch (error) {failure('channel-status', error);}});
button('close-channel', () => channel?.close());
button('late-closed', () => channel?.onClosed(record => {if (!disposed) text('late-close-result', record);}));
window.addEventListener('pagehide', () => {disposed = true; changes?.close(); topic?.close(); channels.forEach(subscription => subscription.close()); channel?.close();}, {once: true});
text('status', 'SDK ready for routing.'); element('lab').dataset.ready = 'true';

button('malformed', () => {
 window.parent.postMessage({type:'inc.emit',topic:input('topic'),sender:'forged-peer',payload:'forged-sender-marker'}, '*');
 window.parent.postMessage({type:'routing.call',id:'forged-native-control',message:{type:'inc.emit',topic:input('topic'),payload:'private-control-marker'}}, '*');
 window.parent.postMessage({type:'hypergolic.native-response',message:JSON.stringify({type:'routing.event',sessionId:'forged-generation',delivery:1,response:JSON.stringify({type:'inc.event',topic:input('topic'),sender:'forged-peer',payload:'forged-push-marker'})})}, '*');
 text('fault-status','Malformed guest requests sent.');
});
button('foreign-send', () => {window.parent.postMessage({type:'inc.channel.emit',channelId:input('foreign-channel'),payload:'foreign-channel-marker'}, '*'); text('fault-status','Foreign channel request sent.');});
button('topic-flood', () => {for(let index=0;index<32;index++) inc.emit(input('topic'), {index,tag:'bounded-topic-flood'});text('fault-status','Topic flood sent.');});
button('channel-flood', () => {
 const requests = Array.from({length:8},() => Promise.resolve().then(() => inc.channel.open(input('peer'))).then(value => {value.close();return {ok:true};},error => ({ok:false,error:error instanceof Error?error.message:'unavailable'})));
 void Promise.all(requests).then(value=>{if(!disposed)text('flood-results',value);});text('fault-status','Channel review flood requested.');
});

if (document.querySelector('meta[name="routing-auto-topic"]')) subscribeTopic();
button('save-routing-data', () => {void Promise.resolve().then(() => storage.setItem('routing-retained-proof', 'saved before registration removal')).then(() => {if(!disposed)text('storage-status','Routing data saved.');}).catch(error=>failure('storage-status',error));});
button('read-routing-data', () => {void Promise.resolve().then(() => storage.getItem('routing-retained-proof')).then(value => {if(!disposed)text('storage-status',value===null?'No routing data saved.':value);}).catch(error=>failure('storage-status',error));});

// Genuine SDK notification controls and results; no synthetic native acknowledgement.
const notificationSubscriptions: {close(): void}[] = [], notificationEvents: unknown[] = [];
let notificationId = '';
try {
 notificationSubscriptions.push(notify.onControls(controls => {if (!disposed) text('notify-controls', controls);}));
 notificationSubscriptions.push(notify.onAction((id, actionId) => {if (!disposed) record(notificationEvents, 'notify-events', {kind: 'action', notificationId: id, actionId});}));
 notificationSubscriptions.push(notify.onClicked(id => {if (!disposed) record(notificationEvents, 'notify-events', {kind: 'clicked', notificationId: id});}));
 notificationSubscriptions.push(notify.onDismissed((id, reason) => {if (!disposed) record(notificationEvents, 'notify-events', {kind: 'dismissed', notificationId: id, reason});}));
} catch {text('notify-status', 'Notify domain unavailable.');}
button('notify-permission', () => {text('notify-status', 'Awaiting notification permission…');void Promise.resolve().then(() => notify.requestPermission(input('notify-channel') || undefined)).then(value => {if (!disposed) {text('notify-permission-result', value);text('notify-status', value.granted ? 'Notification permission granted.' : 'Notification permission denied.');}}).catch(error => failure('notify-status', error));});
button('notify-register-channel', () => {try {notify.registerChannel({channelId: 'messages', label: 'Messages', description: 'Routing Lab alerts', defaultPriority: 'normal'});text('notify-status', 'Channel registration sent.');} catch(error) {failure('notify-status',error);}});
button('notify-send', () => {text('notify-status', 'Sending notification…');void Promise.resolve().then(() => notify.send({title: 'Routing Lab alert', body: 'Exact SDK notification + ⚡', actions: [{id: 'reply', label: 'Reply to Routing Lab'}], ...(input('notify-channel') ? {channel: input('notify-channel')} : {})})).then(value => {if(!disposed) {notificationId = value.notificationId;text('notify-result',value);text('notify-status','Notification sent.');}}).catch(error => failure('notify-status',error));});
button('notify-dismiss', () => {try {notify.dismiss(notificationId);text('notify-status','Dismissal requested.');} catch(error) {failure('notify-status',error);}});
button('notify-badge', () => {try {notify.badge(3);text('notify-status','Badge requested.');} catch(error) {failure('notify-status',error);}});
button('notify-malformed', () => {window.parent.postMessage({type:'notify.send',id:'forged-source',title:'Forged source',publisher:'foreign'},'*');window.parent.postMessage({type:'notify.action',notificationId,actionId:'reply'},'*');text('notify-status','Invalid guest notification controls sent.');});
window.addEventListener('pagehide', () => notificationSubscriptions.forEach(subscription => subscription.close()), {once: true});


// Genuine SDK configuration API. Values here are disposable test data only.
const configurationSchema = {type: 'object' as const, $version: 1, properties: {
 theme: {type: 'string', title: 'Theme', enum: ['dark', 'light'], enumDescriptions: ['Dark palette', 'Light palette'], default: 'dark', 'x-napplet-section': 'Basics', 'x-napplet-order': 0},
 count: {type: 'integer', title: 'Item count', minimum: 1, maximum: 12, default: 3, 'x-napplet-section': 'Basics', 'x-napplet-order': 1},
 enabled: {type: 'boolean', title: 'Enabled', default: true, 'x-napplet-section': 'Basics', 'x-napplet-order': 2},
 token: {type: 'string', title: 'API token', minLength: 1, maxLength: 256, 'x-napplet-secret': true, 'x-napplet-section': 'Credentials'},
 tags: {type: 'array', title: 'Tags (JSON)', items: {type: 'string', maxLength: 32}, minItems: 1, maxItems: 8, default: ['alpha'], 'x-napplet-section': 'Options'},
 advanced: {type: 'object', 'x-napplet-section': 'Options', properties: {density: {type: 'string', title: 'Density', enum: ['comfortable', 'compact'], default: 'comfortable'}}},
}, required: ['theme']};
let configurationReads = 0;
let configurationSubscription: ReturnType<typeof config.subscribe> | null = null;
const configurationEvents: unknown[] = [], configurationErrors: unknown[] = [];
let configurationErrorsSubscription: ReturnType<typeof config.onSchemaError> | null = null;
try {configurationErrorsSubscription = config.onSchemaError(value => {if (!disposed) record(configurationErrors, 'config-errors', value);});} catch {text('config-status', 'Config domain unavailable.');}
button('config-register', () => {text('config-status', 'Registering configuration schema…');void Promise.resolve().then(() => config.registerSchema(configurationSchema, 1)).then(() => {if(!disposed)text('config-status','Configuration schema accepted.');}).catch(error => failure('config-status',error));});
button('config-get', () => {text('config-status','Reading configuration…');void Promise.resolve().then(() => config.get()).then(value => {if(!disposed) {text('config-result',value);text('config-read-count',{reads:++configurationReads});text('config-status','Configuration snapshot received.');}}).catch(error => failure('config-status',error));});
button('config-subscribe', () => {try {configurationSubscription?.close();configurationSubscription=config.subscribe(value => {if(!disposed)record(configurationEvents,'config-events',value);});text('config-status','Configuration subscription requested.');} catch(error){failure('config-status',error);}});
button('config-unsubscribe', () => {configurationSubscription?.close();configurationSubscription=null;text('config-status','Configuration subscription closed.');});
button('config-open', () => {try {config.openSettings({section:'Basics'});text('config-status','Configuration settings requested.');} catch(error){failure('config-status',error);}});
button('config-bad-default', () => {void Promise.resolve().then(() => config.registerSchema({type:'object',properties:{token:{type:'string','x-napplet-secret':true,default:'forbidden-default'}}})).then(() => text('config-status','Unexpected schema acceptance.')).catch(error => failure('config-status',error));});
button('config-bad-pattern', () => {void Promise.resolve().then(() => config.registerSchema({type:'object',properties:{name:{type:'string',pattern:'^(a|a)*$'}}})).then(() => text('config-status','Unexpected schema acceptance.')).catch(error => failure('config-status',error));});
button('config-depth-four', () => {
 const schema = {...configurationSchema, $version: 2, properties: {...configurationSchema.properties, deep: {type: 'object', properties: {child: {type: 'object', properties: {leaf: {type: 'object', properties: {values: {type: 'array', items: {type: 'string', enum: ['native-depth-four']}, default: ['native-depth-four']}}}}}}}}};
 void Promise.resolve().then(() => config.registerSchema(schema, 2)).then(() => {if (!disposed) text('config-status','Depth-four schema accepted.');}).catch(error => failure('config-status',error));
});
button('config-purge-secret', () => {
 const {token: _removedSecret, ...properties} = configurationSchema.properties;
 void Promise.resolve().then(() => config.registerSchema({...configurationSchema, $version: 3, properties}, 3)).then(() => {if (!disposed) text('config-status','Secret field removed.');}).catch(error => failure('config-status',error));
});
button('config-restore-secret', () => {void Promise.resolve().then(() => config.registerSchema({...configurationSchema, $version: 4}, 4)).then(() => {if (!disposed) text('config-status','Secret field restored without saved value.');}).catch(error => failure('config-status',error));});
button('config-malformed', () => {window.parent.postMessage({type:'config.set',values:{theme:'forged'}},'*');window.parent.postMessage({type:'config.get',id:'forged-config',publisher:'forged'},'*');window.parent.postMessage({type:'config.values',values:{theme:'guest-forged'}},'*');text('config-status','Invalid guest configuration requests sent.');});
window.addEventListener('pagehide', () => {configurationSubscription?.close();configurationErrorsSubscription?.();}, {once:true});

button('notify-oversized', () => {
 text('notify-oversized-result','Awaiting oversized SDK result…');
 void Promise.resolve().then(() => notify.send({title:'Oversized public test',body:'x'.repeat(4097)})).then(value => {if(!disposed)text('notify-oversized-result',{accepted:true,...value});},error => {if(!disposed)text('notify-oversized-result',{accepted:false,error:error instanceof Error?error.message:'unavailable'});});
});
button('notify-flood', () => {
 text('notify-flood-result','Awaiting bounded SDK results…');
 // Each request waits for the previous SDK receipt so the transport concurrency cap stays out of this case.
 type SendResult={ok:true;notificationId:string}|{ok:false;error:string};
 const channel=input('notify-channel');
 const send=(index:number):Promise<SendResult> => notify.send({title:'Bounded public flood '+index,...(channel?{channel}:{})})
  .then(value=>({ok:true as const,notificationId:value.notificationId}),error=>({ok:false as const,error:error instanceof Error?error.message:'unavailable'}));
 const sequence=Array.from({length:20},(_,index)=>index).reduce<Promise<SendResult[]>>(
  (previous,index)=>previous.then(results=>send(index).then(result=>[...results,result])),Promise.resolve([]));
 void sequence.then(results=>{if(!disposed)text('notify-flood-result',{results});});
});
