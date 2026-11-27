import type {NappletMessage} from '@kehto/runtime';
import type {GuestBindingTransport} from './guest-port';
import type {createNativeClient} from './native-client';
import {secureUuidV4} from './secure-random-compat';

export function installFileFacade(wire: GuestBindingTransport | undefined, newId: () => string) {
  const guest = window as Window & {napplet?:{fs?:object; shell?:{ready():Promise<unknown>}}};
  const parent = window.parent;
  const pending = new Map<string,{type:string;field:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:number}>();
  let closed = false;
  function call(method:string, field:string, fields:object = {}) {
    if (closed || pending.size >= 4) return Promise.reject(Error('quota-exceeded'));
    const type = 'fs.' + method, id = newId();
    return new Promise((resolve,reject) => {
      const timer = window.setTimeout(() => { pending.delete(id); reject(Error('io-error')); },28_000);
      pending.set(id,{type,field,resolve,reject,timer});
      void Promise.resolve(wire ? undefined : guest.napplet?.shell?.ready()).then(() => {
        if (!pending.has(id)) return;
        const message = {type,id,...fields};
        if (wire) wire.send(message); else parent.postMessage(message,'*');
      }).catch(() => {clearTimeout(timer);pending.delete(id);reject(Error('io-error'));});
    });
  }
  function receive(raw:unknown) {
    if (!raw || typeof raw !== 'object') return;
    const result = raw as Record<string,unknown>;
    if (typeof result.id !== 'string') return;
    const row = pending.get(result.id);
    if (!row || row.type + '.result' !== result.type) return;
    clearTimeout(row.timer);pending.delete(result.id);
    if (typeof result.error === 'string') row.reject(Error(result.error)); else row.resolve(result[row.field]);
  }
  const listener = (e:MessageEvent) => { if (e.isTrusted && e.source === parent) receive(e.data); };
  const detach = wire?.listen(receive);
  if (!wire) window.addEventListener('message',listener);
  window.addEventListener('pagehide',() => {
    closed = true;detach?.();window.removeEventListener('message',listener);
    for (const row of pending.values()) {clearTimeout(row.timer);row.reject(Error('cancelled'));}
    pending.clear();
  },{once:true});
  const unsupported = () => Promise.reject(Error('unsupported'));
  guest.napplet = {...guest.napplet,fs:Object.freeze({
    info:() => call('info','info'),
    stat:(path:string) => call('stat','metadata',{path}),
    list:(path:string) => call('list','entries',{path}),
    read:(path:string,options?:object) => call('read','result',{path,options}),
    write:(path:string,data:string,options?:object) => call('write','result',{path,data,options}),
    pickFile:(options?:object) => call('pickFile','result',{options}),
    pickSaveFile:(options?:object) => call('pickSaveFile','result',{options}),
    pickFiles:unsupported,pickDirectory:unsupported,mkdir:unsupported,move:unsupported,remove:unsupported,watch:unsupported,unwatch:unsupported,
    onChanged:() => ({close() {}}),
  })};
}
export function injectFileFacade(html:string) {
  const head = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!head.test(html)) throw Error('File binding requires host CSP');
  return html.replace(head,value => value + '<script>(' + installFileFacade.toString() + ')(undefined,' + secureUuidV4.toString() + ');</script>');
}
export function fileReceiver(request:ReturnType<typeof createNativeClient>['request'], send:(value:object)=>void, live:()=>boolean, hasFocus:()=>boolean) {
  return (value:Record<string,unknown>) => {
    if (!live() || typeof value.type !== 'string' || typeof value.id !== 'string' || !value.id || value.id.length > 128) return;
    const {type,id} = value;
    const error = (code:string) => { if (live()) send({type:type + '.result',id,error:code}); };
    if ((type === 'fs.pickFile' || type === 'fs.pickSaveFile') && !hasFocus()) { error('policy-denied'); return; }
    void request({...value,type,id} as NappletMessage).then(result => { if (live()) send(result); }, () => error('io-error'));
  };
}
