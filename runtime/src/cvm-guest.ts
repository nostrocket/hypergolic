/** The namespace is installed only for a newly reviewed effective CVM grant. Parent validates every operation. */
function installCvmFacade():void{
  const guest=window as Window&{napplet?:{shell?:{ready():Promise<unknown>};cvm?:object}};
  const parent=window.parent,post=parent.postMessage.bind(parent),pending=new Map<string,{type:string;resolve:(reply:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:number;provider?:string}>();
  const closedProviders=new Set<string>();
  const handlers=new Set<((event:unknown)=>void)|((server:unknown,message:unknown)=>void)>();let closed=false;
  function call(type:string,fields:object={},timeout=30000):Promise<Record<string,unknown>>{
    if(closed||pending.size>=4)return Promise.reject(new Error('CVM unavailable'));
    const id='cvm-'+crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=window.setTimeout(()=>{pending.delete(id);reject(new Error('relay timeout'));},Math.min(120000,Math.max(1,timeout))+2000);
      const server=(fields as {server?:{pubkey?:unknown}}).server,provider=typeof server?.pubkey==='string'?server.pubkey:undefined;
      pending.set(id,{type,resolve,reject,timer,...(provider===undefined?{}:{provider})});
      void Promise.resolve().then(()=>guest.napplet?.shell?.ready()).then(()=>{if(pending.has(id))post({...fields,type,id},'*');},()=>{const row=pending.get(id);if(row){pending.delete(id);clearTimeout(timer);reject(new Error('CVM unavailable'));}});
    });
  }
  const receive=(event:MessageEvent)=>{
    if(closed||!event.isTrusted||event.source!==parent||!event.data||typeof event.data!=='object')return;
    const reply=event.data as Record<string,unknown>;
    if(reply.type==='cvm.event'){
      if(closedProviders.has((reply.server as {pubkey?:string}|undefined)?.pubkey??''))return;
      const value=Object.freeze({server:reply.server,message:reply.message});for(const handler of handlers)try{if(handler.length>=2)(handler as (server:unknown,message:unknown)=>void)(reply.server,reply.message);else(handler as (event:unknown)=>void)(value);}catch{/* Guest callbacks do not alter transport. */}return;
    }
    if(typeof reply.id!=='string')return;const row=pending.get(reply.id);if(!row||reply.type!==row.type+'.result')return;
    pending.delete(reply.id);clearTimeout(row.timer);if(typeof reply.error==='string')row.reject(new Error(reply.error));else row.resolve(reply);
  };
  window.addEventListener('message',receive);window.addEventListener('pagehide',()=>{closed=true;window.removeEventListener('message',receive);for(const row of pending.values()){clearTimeout(row.timer);row.reject(new Error('session closed'));}pending.clear();handlers.clear();},{once:true});
  type Options={timeoutMs?:number;initialize?:boolean;payment?:'deny'|'prompt'|'allow'};
  async function request(server:unknown,message:unknown,options?:Options):Promise<Record<string,unknown>|null>{
    const provider=(server as {pubkey?:unknown}|undefined)?.pubkey;if(typeof provider==='string')closedProviders.delete(provider);
    const reply=await call('cvm.request',{server,message,...(options===undefined?{}:{options})},options?.timeoutMs??30000);
    return Object.prototype.hasOwnProperty.call(reply,'message')?reply.message as Record<string,unknown>:null;
  }
  async function mcp(server:unknown,method:string,params?:object,options?:Options):Promise<Record<string,unknown>>{
    const reply=await request(server,{jsonrpc:'2.0',id:crypto.randomUUID(),method,...(params===undefined?{}:{params})},options);
    if(!reply||reply.error){const error=reply?.error as {message?:unknown}|undefined;throw new Error(typeof error?.message==='string'?error.message:'MCP request failed');}
    if(!reply.result||typeof reply.result!=='object'||Array.isArray(reply.result))throw new Error('invalid message');return reply.result as Record<string,unknown>;
  }
  const facade=Object.freeze({request,
    async listTools(server:unknown,options?:Options){return (await mcp(server,'tools/list',undefined,options)).tools;},
    callTool:(server:unknown,name:string,args?:object,options?:Options)=>mcp(server,'tools/call',{name,...(args===undefined?{}:{arguments:args})},options),
    async listResources(server:unknown,options?:Options){return (await mcp(server,'resources/list',undefined,options)).resources;},
    async readResource(server:unknown,uri:string,options?:Options){return (await mcp(server,'resources/read',{uri},options)).contents;},
    async close(server:unknown){
      const provider=(server as {pubkey?:unknown}|undefined)?.pubkey;
      if(typeof provider==='string'){if(closedProviders.size>=64)closedProviders.delete(closedProviders.values().next().value!);closedProviders.add(provider);for(const [id,row] of pending)if(row.type==='cvm.request'&&row.provider===provider){pending.delete(id);clearTimeout(row.timer);row.reject(new Error('session closed'));}}
      await call('cvm.close',{server});
    },
    async discover(query?:object){return (await call('cvm.discover',query===undefined?{}:{query})).servers;},
    onEvent(handler:((event:unknown)=>void)|((server:unknown,message:unknown)=>void)){if(typeof handler!=='function'||handlers.size>=32)throw new Error('CVM listener unavailable');handlers.add(handler);return{close(){handlers.delete(handler);}};},
    registry:Object.freeze({
      async list(query?:object){return (await call('cvm.registry.list',query===undefined?{}:{query})).entries;},
      async has(selector:object,options?:object){return (await call('cvm.registry.has',{selector,...(options===undefined?{}:{options})})).has===true;},
      async describe(selector:object,options?:object){return (await call('cvm.registry.describe',{selector,...(options===undefined?{}:{options})})).entry;},
      async call(selector:object,tool:string,args?:object,options?:Options){return (await call('cvm.registry.call',{selector,tool,...(args===undefined?{}:{args}),...(options===undefined?{}:{options})},options?.timeoutMs??30000)).result;},
    }),
  });
  guest.napplet={...guest.napplet,cvm:facade};
}
export function injectCvmFacade(html:string):string{
  const head=/<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if(!head.test(html))throw new Error('CVM binding requires host CSP');
  return html.replace(head,value=>`${value}<script>(${installCvmFacade.toString()})();</script>`);
}
