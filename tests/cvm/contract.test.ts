import test from 'node:test';
import assert from 'node:assert/strict';
import {captureMcp,captureOptions,parseCvmOperation,CvmError,mcpKey,CVM_LIMITS} from '../../src/cvm/cvm-contract.ts';
import {captureCvmJson} from '../../src/cvm/cvm-json.ts';
const server={pubkey:'1'.repeat(64),relays:['wss://relay.example.com']};
const request=(message:unknown,options?:unknown)=>({type:'cvm.request',id:'envelope',server,message,...(options===undefined?{}:{options})});
const fail=(run:()=>unknown,code:string)=>assert.throws(run,error=>error instanceof CvmError&&error.code===code);
test('later JSON.stringify mutation cannot bypass the captured CVM serialized byte bound',()=>{
  const original=JSON.stringify;let rejected=false,valid:unknown;
  try {
    JSON.stringify=()=> '0';
    valid=captureCvmJson({text:'owned'});
    try {captureCvmJson('\\'.repeat(CVM_LIMITS.messageBytes/2));} catch {rejected=true;}
  } finally {JSON.stringify=original;}
  assert.deepEqual(valid,{text:'owned'});assert.equal(rejected,true);
});

test('all MCP forms preserve payload, typed IDs and immutable capture',()=>{
  const input={jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'chat.complete',arguments:{messages:['owned fixture']}}};
  const captured=captureMcp(input);input.params.arguments.messages.push('late mutation');
  assert.deepEqual(captured.params,{name:'chat.complete',arguments:{messages:['owned fixture']}});
  assert(Object.isFrozen(captured)&&Object.isFrozen(captured.params));
  assert.equal(mcpKey(7),'number:7');assert.notEqual(mcpKey(7),mcpKey('7'));
  assert.equal(captureMcp({jsonrpc:'2.0',id:'',method:'ping'}).id,'');
  assert.deepEqual(captureMcp({jsonrpc:'2.0',method:'notifications/initialized'}),{jsonrpc:'2.0',method:'notifications/initialized'});
  assert.deepEqual(captureMcp({jsonrpc:'2.0',id:'server-id',result:{}}),{jsonrpc:'2.0',id:'server-id',result:{}});
  assert.deepEqual(captureMcp({jsonrpc:'2.0',id:1,error:{code:-32601,message:'unsupported'}}).error,{code:-32601,message:'unsupported'});
});
test('malformed form/ID/error has invalid-message before any side effect',()=>{
  for(const value of [null,[],{jsonrpc:'1.0',id:1,method:'ping'},
    {jsonrpc:'2.0',id:null,method:'ping'},{jsonrpc:'2.0',id:1,result:{},error:{}},
    {jsonrpc:'2.0',id:1,method:'ping',result:{}},{jsonrpc:'2.0',id:1},
    {jsonrpc:'2.0',id:1,result:{},params:{}},{jsonrpc:'2.0',id:1,error:{code:1.2,message:'x'}},
    {jsonrpc:'2.0',id:Number.MAX_SAFE_INTEGER+1,method:'ping'}])fail(()=>captureMcp(value),'invalid message');
});
test('JSON capture retains actual JSON bytes for Unicode, escapes and negative zero',()=>{
  for(const value of [{text:'"\\\n\u0000\ud800\udc00\ud800'},[-0,0,1.25,null,true],{'__proto__':null}]){
    const ordinary=value===undefined?null:value;
    if(Object.getPrototypeOf(ordinary)===null)continue;
    assert.equal(JSON.stringify(captureCvmJson(ordinary)),JSON.stringify(ordinary));
  }
  const exact='x'.repeat(CVM_LIMITS.messageBytes-2);assert.equal(captureCvmJson(exact),exact);
  assert.throws(()=>captureCvmJson(exact+'x'));
  assert.throws(()=>captureCvmJson('\\'.repeat(CVM_LIMITS.messageBytes/2)));
});
test('getters, sparse arrays, cycles, symbols and non-JSON numbers never cross capture',()=>{
  let getter=0;const bad={};Object.defineProperty(bad,'data',{enumerable:true,get(){getter++;return 1;}});
  assert.throws(()=>captureCvmJson(bad));assert.equal(getter,0);
  const cycle:{self?:unknown}={};cycle.self=cycle;
  for(const value of [[,1],cycle,{n:Infinity},{n:NaN},{s:Symbol()},Object.create({x:1}),{[Symbol()]:1}])assert.throws(()=>captureCvmJson(value));
});
test('requested120s is preserved, malformed and out-of-policy timeouts are distinct',()=>{
  assert.equal(captureOptions({timeoutMs:120000}).timeoutMs,120000);
  assert.deepEqual(captureOptions(undefined),{timeoutMs:30000,initialize:true,payment:'prompt'});
  for(const timeoutMs of [null,undefined,0,-1,1.2,'120000',300001])fail(()=>captureOptions({timeoutMs}),'invalid timeout');
  fail(()=>captureOptions({timeoutMs:120001}),'timeout out of policy');
  fail(()=>captureOptions({payment:null}),'invalid request');
  assert.equal(captureOptions({payment:'allow'}).payment,'allow'); // This option itself grants no spending.
});
test('server and known wire-operation shapes are exact and immutable',()=>{
  const value=parseCvmOperation(request({jsonrpc:'2.0',id:1,method:'ping'}));
  assert.equal(value.type,'cvm.request');assert(Object.isFrozen(value));
  for(const bad of [{...server,pubkey:'A'.repeat(64)},{...server,relays:['wss://relay.example.com','wss://relay.example.com']},
    {...server,relays:Array(5).fill('wss://relay.example.com')},{...server,secret:'never'}])fail(()=>parseCvmOperation({...request({jsonrpc:'2.0',id:1,method:'ping'}),server:bad}),'invalid request');
  for(const type of ['cvm.discover','cvm.registry.list'])assert.equal(parseCvmOperation({type,id:'id'}).type,type);
  for(const type of ['cvm.registry.has','cvm.registry.describe'])assert.equal(parseCvmOperation({type,id:'id',selector:{schemaHash:'a'.repeat(64)}}).type,type);
  assert.equal(parseCvmOperation({type:'cvm.registry.call',id:'id',selector:{family:'owned'},tool:'read',args:{}}).type,'cvm.registry.call');
  fail(()=>parseCvmOperation({type:'cvm.registry.has',id:'id',selector:{}}),'invalid request');
  fail(()=>parseCvmOperation({type:'cvm.registry.call',id:'id',selector:{family:'owned'},tool:'read',options:{timeoutMs:300001}}),'invalid timeout');
});
