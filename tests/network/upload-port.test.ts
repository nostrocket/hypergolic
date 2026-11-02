import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeUploadPort, type UploadModule} from '../../src/uploads/upload-port.ts';
import {UPLOAD_LIMITS, UploadError} from '../../src/uploads/upload-contract.ts';
const capture = () => ({registration: {sessionId:'session-one',generation:'generation-one',epoch:1,user:'11'.repeat(32),publisher:'22'.repeat(32),
  appId:'upload-lab',version:'33'.repeat(32),instanceId:'instance-one',fixture:'published',domains:['theme','upload']},
  request: JSON.stringify({rail:'blossom',filename:'image.png',caption:'selected',metadata:{purpose:'fixture'},noTransform:true}), uploadId:'public-one',
  review: {purpose:'blossom-upload',identity:'11'.repeat(32),destination:'https://files.example.org',sha256:'44'.repeat(32),size:3,mimeType:'image/png',metadataPolicy:'photo-stripped'}});
function fixture() {
  let raw: string | null = JSON.stringify(capture()), base64: string | null = 'AQID';
  const calls: string[] = [], finished: string[] = [];
  const module: UploadModule = {
    takeUpload: token => {calls.push('take:'+token); const value=raw;raw=null;return value;},
    isUploadLive: token => {calls.push('live:'+token);return true;}, mayReviewUpload: () => true,
    readUploadPreview: (token,offset) => {calls.push('preview:'+token+':'+offset);return base64;}, approveUpload: () => true,
    isUploadApproved: () => true, claimUploadSigning: () => true,
    putUpload: async () => JSON.stringify({ok:true,descriptor:{url:'https://files.example.org/'+ '44'.repeat(32)+'.png',sha256:'44'.repeat(32),size:3,type:'image/png',uploaded:1}}),
    wasUploadDispatched: () => true, cancelUpload: token => {calls.push('cancel:'+token);},
    finishUpload: (token,result) => {calls.push('finish:'+token);finished.push(result);},
  };
  return {module,calls,finished,raw:(value: unknown) => {raw=typeof value === 'string'?value:JSON.stringify(value);},base64:(value: string | null) => {base64=value;}};
}
test('native capture supplies an opaque lease and original owning tuple with no SDK token projection', async () => {
  const f=fixture(), port=createNativeUploadPort(f.module), taken=port.take('native-token')!;
  assert(Object.isFrozen(taken.lease)); assert.equal(taken.origin.generation,'generation-one'); assert.equal(taken.origin.user,'11'.repeat(32));
  assert.equal(taken.filename,'image.png'); assert.equal(taken.caption,'selected'); assert.equal(taken.uploadId,'public-one');
  assert.equal(port.take('native-token'),null); assert.deepEqual([...port.readPreview(taken.lease,0)],[1,2,3]);
  const descriptor=await port.put(taken.lease,'private-credential'); assert.equal((descriptor as {sha256:string}).sha256,'44'.repeat(32));
  port.finish(taken.lease,{ok:true,uploadId:'public-one',status:'complete',rail:'blossom',url:'https://files.example.org/'+ '44'.repeat(32)+'.png',sha256:'44'.repeat(32),size:3,mimeType:'image/png'});
  assert.equal(f.finished.length,1); assert(!f.finished[0]!.includes('native-token')); assert(!f.finished[0]!.includes('private-credential'));
  assert.throws(() => port.isLive(taken.lease),UploadError); assert.throws(() => port.isLive({}),UploadError);
});
test('native capture refuses missing grants, changed identity, scope fields and embedded data before presentation', () => {
  const variants: unknown[]=[];
  const a=capture(); a.registration.domains=['theme']; variants.push(a);
  const b=capture(); b.registration.domains=['upload','upload']; variants.push(b);
  const c=capture(); c.review.identity='ff'.repeat(32); variants.push(c);
  const d=capture(); d.request=JSON.stringify({rail:'blossom',data:'hidden bytes'}); variants.push(d);
  const e=capture(); e.request=JSON.stringify({rail:'blossom',destination:'https://other.example.org'}); variants.push(e);
  variants.push({...capture(),extra:'authority'}, {...capture(),registration:{...capture().registration,extra:'authority'}},
    {...capture(),review:{...capture().review,extra:'authority'}}, 'x'.repeat(40*1024+1));
  for(const value of variants){const f=fixture();f.raw(value);const port=createNativeUploadPort(f.module);assert.equal(port.take('token'),null);assert.deepEqual(f.calls,['take:token','cancel:token']);}
});
test('native preview refuses invalid offsets and malformed/noncanonical/oversized base64', () => {
  const f=fixture(),port=createNativeUploadPort(f.module),taken=port.take('token')!;
  for(const value of [null,'','AB==','AQ=I','AQID\n','?QID','AQID'.repeat(Math.ceil(UPLOAD_LIMITS.chunkBytes/3)+1)]) {
    f.base64(value); assert.throws(() => port.readPreview(taken.lease,0),UploadError);
  }
  f.base64('AQID'); const count=f.calls.length;
  for(const offset of [-1,1,NaN,1.5])assert.throws(() => port.readPreview(taken.lease,offset),UploadError);
  assert.equal(f.calls.length,count);
});
test('native transfer envelopes reject provider state and preserve only declared failure reasons', async () => {
  for(const response of [{ok:false,error:'server rejected'},{ok:false,error:'private diagnostic'},
    {ok:true,descriptor:{},token:'private'},null,'not json']) {
    const f=fixture();f.module.putUpload=async()=>typeof response==='string'?response:JSON.stringify(response);
    const port=createNativeUploadPort(f.module),taken=port.take('token')!;
    await assert.rejects(port.put(taken.lease,'credential'));
  }
});
test('changed public upload ID cannot finish another lease or revoke its private adapter token', () => {
  const f=fixture(),port=createNativeUploadPort(f.module),taken=port.take('token')!;
  assert.throws(() => port.finish(taken.lease,{ok:false,uploadId:'foreign',status:'failed',rail:'blossom',error:'outcome unknown'}),UploadError);
  assert.equal(f.finished.length,0);assert(port.isLive(taken.lease));
});
test('progress binds the original private lease, native approval and monotonic bounded counters', () => {
  const f=fixture(); let deliver: ((event: unknown) => void) | null=null, removed=false, approved=false;
  f.module.addListener=(name, listener)=>{assert.equal(name,'onUploadProgress');deliver=listener;return {remove(){removed=true;}};};
  f.module.isUploadApproved=()=>approved;
  const port=createNativeUploadPort(f.module),taken=port.take('token')!, updates: number[]=[];
  const detach=port.observeProgress!(taken.lease,(sent,total)=>{assert.equal(total,3);updates.push(sent);});
  const push=(value: unknown)=>{assert(deliver);deliver(value);};
  push({token:'token',bytesSent:1,bytesTotal:3});assert.deepEqual(updates,[]);
  approved=true;
  for(const event of [{token:'foreign',bytesSent:1,bytesTotal:3},{token:'token',bytesSent:-1,bytesTotal:3},
    {token:'token',bytesSent:4,bytesTotal:3},{token:'token',bytesSent:1,bytesTotal:3,credential:'hidden'}])push(event);
  push({token:'token',bytesSent:2,bytesTotal:3});push({token:'token',bytesSent:1,bytesTotal:3});assert.deepEqual(updates,[2]);
  port.finish(taken.lease,{ok:false,uploadId:'public-one',status:'failed',rail:'blossom',error:'outcome unknown'});
  push({token:'token',bytesSent:3,bytesTotal:3});assert.deepEqual(updates,[2]);detach();assert(removed);
});
