import test from 'node:test';
import assert from 'node:assert/strict';
import {CvmStreamReceiver} from '../../src/cvm/cvm-stream.ts';
const frame=(progress:number,frameType:string,extra:object={})=>({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'owned',progress,cvm:{type:'open-stream',frameType,...extra}}});
test('server stream validates start/chunks/close and sends own independent accept sequence',()=>{
 const s=new CvmStreamReceiver('owned',()=>0);const start=s.receive(frame(1,'start'));assert.equal(start.send[0]?.params?.progress,1);
 assert.equal(s.receive(frame(2,'chunk',{chunkIndex:0,data:'first'})).deliver.length,1);
 assert.equal(s.receive(frame(3,'chunk',{chunkIndex:1,data:'second'})).deliver.length,1);
 assert.equal(s.receive(frame(4,'close',{lastChunkIndex:1})).terminal,true);s.final();
 assert.equal(s.receive(frame(5,'chunk',{chunkIndex:2,data:'late'})).deliver.length,0);
});
test('zero-chunk completion, gaps/resource bounds, repeated start and ordering are enforced',()=>{
 const zero=new CvmStreamReceiver('owned',()=>0);zero.receive(frame(1,'start'));zero.receive(frame(2,'close'));zero.final();
 for(const bad of [frame(1,'close'),frame(2,'start')])assert.throws(()=>new CvmStreamReceiver('owned',()=>0).receive(bad));
 const gap=new CvmStreamReceiver('owned',()=>0);gap.receive(frame(1,'start'));assert.equal(gap.receive(frame(2,'chunk',{chunkIndex:1,data:'gap'})).deliver.length,0);assert.throws(()=>gap.receive(frame(3,'close',{lastChunkIndex:1})));
 const start=new CvmStreamReceiver('owned',()=>0);start.receive(frame(1,'start'));assert.throws(()=>start.receive(frame(2,'start')));
 const order=new CvmStreamReceiver('owned',()=>0);order.receive(frame(1,'start'));assert.throws(()=>order.receive(frame(1,'ping',{nonce:'x'})));
 const bound=new CvmStreamReceiver('owned',()=>0);bound.receive(frame(1,'start'));assert.throws(()=>bound.receive(frame(2,'chunk',{chunkIndex:17,data:'far'})));
});
test('ping/pong exact nonce and idle probe lifetime do not manufacture stream completion',()=>{
 let now=0;const s=new CvmStreamReceiver('owned',()=>now);s.receive(frame(1,'start'));
 const pong=s.receive(frame(2,'ping',{nonce:'server'}));assert.equal(pong.send[0]?.params?.progress,2);assert.equal((pong.send[0]?.params?.cvm as {nonce:string}).nonce,'server');
 now=10000;assert.equal(s.idle('client').length,1);assert.throws(()=>s.receive(frame(3,'pong',{nonce:'other'})));
 const timeout=new CvmStreamReceiver('owned',()=>now);timeout.receive(frame(1,'start'));now+=10000;timeout.idle('probe');now+=5000;assert.throws(()=>timeout.idle('ignored'));
 assert.throws(()=>s.final());
});
test('other request tokens cannot feed a stream or trigger a transport control',()=>{
 const s=new CvmStreamReceiver('owned',()=>0);const other=frame(1,'start');other.params.progressToken='foreign';
 assert.deepEqual(s.receive(other),{deliver:[],send:[],terminal:false});
});

test('malformed or aborted stream cannot be rescued by later close or successful MCP result',()=>{
 const broken=new CvmStreamReceiver('owned',()=>0);broken.receive(frame(1,'start'));
 assert.throws(()=>broken.receive(frame(1,'chunk',{chunkIndex:0,data:'bad'})));assert.throws(()=>broken.receive(frame(2,'close')));assert.throws(()=>broken.final());
 const aborted=new CvmStreamReceiver('owned',()=>0);aborted.receive(frame(1,'start'));aborted.receive(frame(2,'abort',{reason:'owned stop'}));assert.throws(()=>aborted.final());
 const premature=new CvmStreamReceiver('owned',()=>0);premature.receive(frame(1,'start'));assert.throws(()=>premature.final());assert.throws(()=>premature.receive(frame(2,'close')));
});
