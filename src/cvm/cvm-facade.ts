import {CvmError,captureMcp,type CvmServer,type McpMessage,type CvmOptions,type CvmObject} from './cvm-contract.ts';
import type {JsonValue} from '../routing/routing-contract.ts';
export type CvmCall=(request:Readonly<Record<string,unknown>>)=>Promise<Readonly<Record<string,unknown>>|null>;
/** Shared facade for the private authenticated projection; this function grants no native access. */
export function createCvmFacade(call:CvmCall,uuid:()=>string){
  async function request(server:CvmServer,message:McpMessage,options?:Partial<CvmOptions>):Promise<McpMessage|null>{
    const id=uuid();const reply=await call({type:'cvm.request',id,server,message,...(options===undefined?{}:{options})});
    if(!reply||reply.type!=='cvm.request.result'||reply.id!==id)throw new CvmError('session closed');
    if(typeof reply.error==='string')throw new Error(reply.error);
    if(!Object.prototype.hasOwnProperty.call(reply,'message')){
      if(message.method!==undefined&&message.id!==undefined)throw new CvmError('invalid message');
      return null;
    }
    const captured=captureMcp(reply.message);
    if(message.method===undefined||message.id===undefined||captured.id!==message.id||captured.method!==undefined)throw new CvmError('invalid message');
    return captured;
  }
  async function mcp(server:CvmServer,method:string,params:CvmObject|undefined,options?:Partial<CvmOptions>):Promise<CvmObject>{
    const message=await request(server,{jsonrpc:'2.0',id:uuid(),method,...(params===undefined?{}:{params})},options);
    if(!message||message.method!==undefined||message.result===undefined){
      if(message?.error)throw new Error(typeof message.error.message==='string'?message.error.message:'MCP request failed');
      throw new CvmError('invalid message');
    }
    return message.result;
  }
  function array(result:CvmObject,name:string):readonly JsonValue[]{
    const value=result[name];if(!Array.isArray(value))throw new CvmError('invalid message');return value;
  }
  return Object.freeze({request,
    listTools:async(server:CvmServer,options?:Partial<CvmOptions>)=>array(await mcp(server,'tools/list',undefined,options),'tools'),
    callTool:(server:CvmServer,name:string,args?:CvmObject,options?:Partial<CvmOptions>)=>mcp(server,'tools/call',{name,...(args===undefined?{}:{arguments:args})},options),
    listResources:async(server:CvmServer,options?:Partial<CvmOptions>)=>array(await mcp(server,'resources/list',undefined,options),'resources'),
    readResource:async(server:CvmServer,uri:string,options?:Partial<CvmOptions>)=>array(await mcp(server,'resources/read',{uri},options),'contents'),
    close:async(server:CvmServer)=>{
      const id=uuid(),reply=await call({type:'cvm.close',id,server});
      if(!reply||reply.type!=='cvm.close.result'||reply.id!==id)throw new CvmError('session closed');
      if(reply.error!==undefined)throw new Error(String(reply.error));
    },
  });
}
