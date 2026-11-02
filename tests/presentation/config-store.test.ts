import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openConfigStore, CONFIG_STORE_SERVICE, type ConfigProtectedOptions, type ConfigSecureStore} from '../../src/presentation/config-store.ts';
import {ShellStorageError} from '../../src/storage/ports.ts';
const hash=async(text:string)=>createHash('sha256').update(text).digest('hex');
const owner={user:'01'.repeat(32),publisher:'02'.repeat(32),appId:'config-lab',version:'03'.repeat(32),instanceId:'view1',assertActive(){}};
function backend(){
 const data=new Map<string,string>(),calls:{key:string;options:ConfigProtectedOptions;value?:string}[]=[];
 let failure=false,mismatch=false;
 const native:ConfigSecureStore={isAvailableAsync:async()=>true,getItemAsync:async(key,options)=>{calls.push({key,options});return mismatch?'bad-readback':data.get(key)??null;},setItemAsync:async(key,value,options)=>{calls.push({key,options,value});if(failure)throw Error('Sensitive native error must be discarded');data.set(key,value);}};
 return {data,calls,native,fail:(value:boolean)=>{failure=value;},mismatch:()=>{mismatch=true;}};
}
test('encrypted native API uses a distinct service and captured user/publisher/app/hash scope; same version reopens',async()=>{
 const b=backend(),first=await openConfigStore(b.native,hash,9),record={format:1 as const,ordinary:{theme:'dark'},secrets:{'["token"]':'public-test-token'}};await first.change(owner,()=>record);const reopened=await openConfigStore(b.native,hash,9);assert.deepEqual(await reopened.read({...owner,instanceId:'another-view'}),record);
 for(const patch of [{user:'04'.repeat(32)},{publisher:'05'.repeat(32)},{appId:'other'},{version:'06'.repeat(32)}])assert.deepEqual((await reopened.read({...owner,...patch})).secrets,{});
 assert.ok(b.calls.every(row=>row.options.keychainService===CONFIG_STORE_SERVICE&&row.options.requireAuthentication===false&&row.options.keychainAccessible===9&&/^scope\.[0-9a-f]{64}$/.test(row.key)));assert.ok(b.calls.every(row=>!row.key.includes('token')&&!row.key.includes('secret.')));
 // This backend is an API double. It does not prove native encryption or native restart.
});
test('queued revoked owner cannot write or read; native failures are sanitized and never success by readback',async()=>{
 const b=backend(),store=await openConfigStore(b.native,hash,9);let active=true;const bound={...owner,assertActive(){if(!active)throw new ShellStorageError('REVOKED');}};active=false;await assert.rejects(store.change(bound,()=>({format:1,ordinary:{},secrets:{}})),error=>error instanceof ShellStorageError&&error.code==='REVOKED');assert.equal(b.calls.length,0);
 b.fail(true);await assert.rejects(store.change(owner,()=>({format:1,ordinary:{theme:'light'},secrets:{}})),error=>error instanceof ShellStorageError&&error.code==='STORAGE_INDETERMINATE'&&!error.message.includes('Sensitive'));assert.equal(b.data.size,0);
});
test('malformed native records are bounded and sanitized, and same-scope changes serialize',async()=>{
 const b=backend(),store=await openConfigStore(b.native,hash,9);await Promise.all(Array.from({length:4},()=>store.change(owner,current=>({format:1,ordinary:{count:(current.ordinary.count as number??0)+1},secrets:{}}))));assert.equal((await store.read(owner)).ordinary.count,4);
 b.mismatch();await assert.rejects(store.read(owner),error=>error instanceof ShellStorageError&&error.code==='CORRUPT_STORAGE'&&!error.message.includes('bad-readback'));
});
