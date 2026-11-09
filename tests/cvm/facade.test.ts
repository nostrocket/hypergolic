import test from 'node:test';
import assert from 'node:assert/strict';
import {createCvmFacade} from '../../src/cvm/cvm-facade.ts';
import type {McpMessage} from '../../src/cvm/cvm-contract.ts';
const server={pubkey:'1'.repeat(64)};
test('readResource preserves every text/blob content in order and requested120s',async()=>{
 let captured:unknown;let counter=0;
 const contents=[{uri:'owned:a',text:'first'},{uri:'owned:b',blob:'AA==',mimeType:'application/octet-stream'}];
 const facade=createCvmFacade(async request=>{
  captured=request;const message=request.message as McpMessage;
  return{type:'cvm.request.result',id:request.id,message:{jsonrpc:'2.0',id:message.id,result:{contents}}};
 },()=>String(++counter));
 assert.deepEqual(await facade.readResource(server,'owned:all',{timeoutMs:120000}),contents);
 assert.deepEqual((captured as {options:unknown}).options,{timeoutMs:120000});
});
test('remoteMCP error is failure ratherthan successful emptytools/resources',async()=>{
 const facade=createCvmFacade(async request=>({type:'cvm.request.result',id:request.id,message:{jsonrpc:'2.0',id:(request.message as McpMessage).id,error:{code:-32601,message:'No tool'}}}),()=> 'owned');
 await assert.rejects(facade.listTools(server),/No tool/);
 await assert.rejects(facade.readResource(server,'owned:none'),/No tool/);
});
test('raw notifications/responses resolve null for properpublication ACK',async()=>{
 const facade=createCvmFacade(async request=>({type:'cvm.request.result',id:request.id}),()=> 'owned');
 assert.equal(await facade.request(server,{jsonrpc:'2.0',method:'notifications/initialized'}),null);
 assert.equal(await facade.request(server,{jsonrpc:'2.0',id:'server-id',result:{}}),null);
 await assert.rejects(facade.request(server,{jsonrpc:'2.0',id:'client-id',method:'ping'}),/invalid message/);
});
