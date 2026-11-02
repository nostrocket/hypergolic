import { createResourceService } from '../../src/resources/resource-service.ts';
import { createResourceTransfers } from '../../src/resources/resource-transfers.ts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {finalizeEvent} from 'nostr-tools/pure';
import {createRelaySubscriptions} from '../../src/network/relay-subscriptions.ts';
import type {NativeRelaySubscriptionPort} from '../../src/runtime/relay-subscription-broker.ts';
import { IdentityTransition } from '../../src/security/identity-transition.ts';
import { Integrated, pubkey } from '../security/harness.ts';
import { setup, deferred } from '../storage/harness.ts';
import { bundledDescriptor, assertBundledWorkspace, resolveBundledSession } from '../../src/shell/fixtures.ts';
import { emptyWorkspace, openNapplet, closeNapplet, focusNapplet } from '../../src/shell/workspace.ts';
import { createRuntimeOwner, type RuntimeBinding } from '../../src/runtime/runtime-owner.ts';
import { createApprovalOwner } from '../../src/security/approval-owner.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';
import { NativeLeases } from './native-leases.ts';
import type { ApprovalService } from '../../src/security/approval-service.ts';

async function start(t: TestContext) {
  const protectedStore = new Integrated(); t.after(() => protectedStore.sqlite.cleanup());
  const vaultOwner = await protectedStore.owner(); await vaultOwner.vault.open();
  const storage = await setup(t);
  const primary = bundledDescriptor('state-lab', 1), instance = bundledDescriptor('state-lab', 2),
    peer = bundledDescriptor('state-lab-peer', 1), publisher = bundledDescriptor('state-lab-other-publisher', 1);
  const seed = () => [primary, instance, peer, publisher].reduce(openNapplet, emptyWorkspace());
  const transition = await IdentityTransition.open({ vault: vaultOwner.vault, database: storage.database, seed, assertAvailable: assertBundledWorkspace });
  const native = new NativeLeases(), owner = createRuntimeOwner(storage.database, transition, native);
  let requests = 0;
  function admit(binding: RuntimeBinding, request: unknown, generation = 'native-generation-1') {
    const config = { ...JSON.parse(binding.configuration), generation } as NativeRegistration;
    const token = native.add(config, request);
    return { token, event: { type: 'capability' as const, sessionId: config.sessionId, generation, token } };
  }
  async function invoke(binding: RuntimeBinding, request: Record<string, unknown>) {
    const { token, event } = admit(binding, { id: String(++requests), ...request });
    const completed = new Promise<unknown>(resolve => { native.onFinish = finished => { if (finished === token) resolve(native.results.get(token)); }; });
    binding.receive(event); return completed;
  }
  return { ...storage, transition, owner, native, primary, instance, peer, publisher, invoke, admit };
}

test('trusted catalogue preserves existing UX descriptors and denies altered State Lab artifacts', () => {
  for (const variant of ['state-lab','state-lab-peer','state-lab-other-publisher'] as const) {
    const descriptor = bundledDescriptor(variant,1);
    const registration = resolveBundledSession(descriptor);
    assert.equal(registration.instanceId,descriptor.id);
    for (const patch of [{source:'published' as const},{publisher:'forged'},{version:'f'.repeat(64)},
      {appId:'other'},{id:'state-lab-0'},{title:'Other'},{eventId:'a'.repeat(64)}]) assert.throws(() => resolveBundledSession({...descriptor,...patch}));
  }
  const ux = bundledDescriptor('ux-lab',1);
  assert.equal(ux.version,'01ab63dbcdadab0b44fd6f3b9a6bcfbd98d8c1de1510f96c821d3efe1876909c');
  assert.notEqual(resolveBundledSession(ux).version,ux.version);
});

test('actual identity/workspace owner binds shared, instance, app and publisher storage independently', {timeout:5000}, async t => {
  const h = await start(t), first = h.owner.open(h.primary), instance = h.owner.open(h.instance);
  const write = await h.invoke(first,{type:'storage.set',key:'sample',value:'primary'});
  assert.deepEqual(write,{type:'storage.set.result',id:'1'});
  assert.deepEqual(await h.invoke(instance,{type:'storage.get',key:'sample'}),{type:'storage.get.result',id:'2',value:'primary'});
  for (const descriptor of [h.peer,h.publisher]) {
    const reply = await h.invoke(h.owner.open(descriptor),{type:'storage.get',key:'sample'}) as {value:unknown};
    assert.equal(reply.value,null);
  }
  await h.invoke(first,{type:'storage.set',key:'sample',value:'instance one',scope:'instance'});
  assert.equal((await h.invoke(instance,{type:'storage.get',key:'sample',scope:'instance'}) as {value:unknown}).value,null);
  // Workspace snapshots are replaced on focus; the original live binding and its correlation history remain valid.
  const workspace = h.transition.getSnapshot().session.workspace;
  workspace.change(focusNapplet(workspace.getSnapshot().workspace,h.instance.id)); await workspace.flush();
  assert.equal((await h.invoke(first,{type:'storage.get',key:'sample'}) as {value:unknown}).value,'primary');
});

test('confirmed identity changes deny old views and returning identities retain their own strings', {timeout:5000}, async t => {
  const h = await start(t), old = h.owner.open(h.primary);
  await h.invoke(old,{type:'storage.set',key:'sample',value:'identity one'});
  const pending = await h.transition.prepareImport(); assert(pending);
  h.transition.cancel(pending);
  assert.equal((await h.invoke(old,{type:'storage.get',key:'sample'}) as {value:unknown}).value,'identity one');
  const change = await h.transition.prepareImport(); assert(change); await h.transition.confirm(change);
  const before = h.native.finishCalls;
  const stale = h.admit(old,{type:'storage.set',id:'stale',key:'sample',value:'must not write'});
  old.receive(stale.event); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.native.finishCalls,before);
  const current = h.owner.open(h.primary);
  assert.equal((await h.invoke(current,{type:'storage.get',key:'sample'}) as {value:unknown}).value,null);
  const back = h.transition.prepareSelect(pubkey(1)); assert(back); await h.transition.confirm(back);
  assert.equal((await h.invoke(h.owner.open(h.primary),{type:'storage.get',key:'sample'}) as {value:unknown}).value,'identity one');
});

test('closing during a real SQL write revokes workspace membership before commit', {timeout:5000}, async t => {
  const h = await start(t), binding = h.owner.open(h.primary), entered = deferred(), release = deferred();
  let held = false;
  h.sqlite.onStep = async sql => { if (sql.startsWith('INSERT INTO saved_strings') && !held) {held=true;entered.resolve();await release.promise;} };
  const write = h.invoke(binding,{type:'storage.set',key:'sample',value:'must roll back'});
  await entered.promise;
  const workspace = h.transition.getSnapshot().session.workspace;
  workspace.change(closeNapplet(workspace.getSnapshot().workspace,h.primary.id));
  release.resolve(); assert.equal(await write,null); await workspace.flush();
  assert.equal(h.sqlite.raw().prepare('SELECT count(*) AS count FROM saved_strings').get()!.count,0);
  assert.throws(() => h.owner.open(h.primary),{code:'REVOKED'});
});


test('new openings get distinct native instance IDs even when display numbers are reused after restart', async t => {
  const h = await start(t);
  const first = h.owner.descriptor('state-lab',4);
  const reopenedOwner = createRuntimeOwner(h.database,h.transition,h.native);
  const second = reopenedOwner.descriptor('state-lab',4);
  assert.equal(first.title,second.title);
  assert.notEqual(first.id,second.id);
  assert.notEqual(resolveBundledSession(first).instanceId,resolveBundledSession(second).instanceId);
  const workspace = h.transition.getSnapshot().session.workspace;
  workspace.change(openNapplet(workspace.getSnapshot().workspace,first)); await workspace.flush();
  const original = h.owner.open(first);
  await h.invoke(original,{type:'storage.set',key:'sample',value:'old instance',scope:'instance'});
  workspace.change(closeNapplet(workspace.getSnapshot().workspace,first.id)); await workspace.flush();
  workspace.change(openNapplet(workspace.getSnapshot().workspace,second)); await workspace.flush();
  assert.equal((await h.invoke(reopenedOwner.open(second),{type:'storage.get',key:'sample',scope:'instance'}) as {value:unknown}).value,null);
});


test('approval owner accepts the resolved native catalogue tuple and revokes changed ownership', async t => {
  const h = await start(t), approval = h.owner.descriptor('approval-lab', 5);
  const workspace = h.transition.getSnapshot().session.workspace;
  workspace.change(openNapplet(workspace.getSnapshot().workspace, approval)); await workspace.flush();
  const origin = { ...JSON.parse(h.owner.open(approval).configuration), generation: 'native-approval-generation' };
  const owner = createApprovalOwner(h.transition);
  assert.notEqual(approval.publisher, origin.publisher);
  assert.doesNotThrow(() => owner.assertActive(origin));
  for (const patch of [{ publisher: approval.publisher }, { instanceId: 'different-instance' },
    { sessionId: 'missing-session' }, { version: '00'.repeat(32) }, { user: pubkey(2) }, { epoch: origin.epoch + 1 }]) {
    assert.throws(() => owner.assertActive({ ...origin, ...patch }));
  }
  const readOnly = { ...JSON.parse(h.owner.open(h.primary).configuration), generation: 'native-state-generation' };
  assert.throws(() => owner.assertActive(readOnly));
  workspace.change(closeNapplet(workspace.getSnapshot().workspace, approval.id));
  assert.throws(() => owner.assertActive(origin)); await workspace.flush();
});

test('each admitted signing request snapshots the current trusted network relay list', async t => {
  const h = await start(t), descriptor = h.owner.descriptor('approval-lab', 9);
  const workspace = h.transition.getSnapshot().session.workspace;
  workspace.change(openNapplet(workspace.getSnapshot().workspace, descriptor)); await workspace.flush();
  let relays: readonly string[] = Object.freeze(['wss://first.example.org']);
  const captured: string[][] = [];
  const approval = { enqueue: (_token: string, destinations: readonly string[]) => { captured.push([...destinations]); return true; }, close: () => undefined } as unknown as ApprovalService;
  const owner = createRuntimeOwner(h.database, h.transition, h.native, { service: approval, destinations: () => relays });
  const binding = owner.open(descriptor), config = { ...JSON.parse(binding.configuration), generation: 'relay-settings-generation' } as NativeRegistration;
  for (const [index, next] of [[1, relays], [2, Object.freeze(['wss://changed.example.org'])]] as const) {
    if (index === 2) relays = next;
    const token = h.native.add(config, { type: 'relay.publish', id: `relay-${index}`, event: {} });
    binding.receive({ type: 'capability', sessionId: config.sessionId, generation: config.generation, token, lane: 'approval' });
  }
  assert.deepEqual(captured, [['wss://first.example.org'], ['wss://changed.example.org']]);
});

test('Feed Lab reads use the normal runtime owner and a confirmed identity switch aborts pending delivery', {timeout:5000}, async t => {
  const h = await start(t), descriptor = h.owner.descriptor('feed-lab', 1);
  const workspace = h.transition.getSnapshot().session.workspace;
  workspace.change(openNapplet(workspace.getSnapshot().workspace, descriptor)); await workspace.flush();
  let pending = false, aborted = false;
  const entered = deferred();
  const owner = createRuntimeOwner(h.database, h.transition, h.native, undefined, undefined, {
    async query(_filters, signal, assertActive) {
      assertActive();
      if (!pending) return [];
      entered.resolve();
      return new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve([]); }, {once:true}));
    },
  });
  const binding = owner.open(descriptor);
  assert.deepEqual(await h.invoke(binding, {type:'relay.query',filters:[{kinds:[1]}]}), {type:'relay.query.result',id:'1',events:[]});
  pending = true;
  const query = h.invoke(binding, {type:'relay.query',filters:[{kinds:[1]}]});
  await entered.promise;
  const change = await h.transition.prepareImport(); assert(change); await h.transition.confirm(change);
  assert.equal(await query, null);
  assert.equal(aborted, true);
  assert.equal(JSON.parse(owner.open(descriptor).configuration).user, pubkey(2));
});


test('normal Feed Lab owner preserves streams across focus and revokes paused intent on a confirmed identity change', {timeout:5000}, async t => {
  const h = await start(t), descriptor = h.owner.descriptor('feed-lab', 7);
  const workspace = h.transition.getSnapshot().session.workspace;
  workspace.change(openNapplet(workspace.getSnapshot().workspace, descriptor)); await workspace.flush();
  const rows = new Map<string,string>(), closed = new Set<string>(), deliveries:unknown[] = [];
  const native:NativeRelaySubscriptionPort = {
    take:token=>{const value=rows.get(token)??null;rows.delete(token);return value;}, accept:()=>true,
    isActive:token=>!closed.has(token),mayDeliver:token=>!closed.has(token),
    send:(_token,response)=>{deliveries.push(JSON.parse(response));return true;},close:token=>{closed.add(token);},
  };
  const calls:{sub:string;frame:(text:string)=>void;stopped:number}[]=[];
  const manager=createRelaySubscriptions({newInstanceId:()=>h.native.newInstanceId(),
    open(_id,_url,_request,sub,frame){const call={sub,frame,stopped:0};calls.push(call);return()=>call.stopped++;}},()=>['wss://relay.example.org']);
  t.after(()=>manager.revokeAll());
  const owner=createRuntimeOwner(h.database,h.transition,Object.assign(h.native,{subscriptions:native}),undefined,undefined,undefined,manager);
  const binding=owner.open(descriptor), registration={...JSON.parse(binding.configuration),generation:'real-stream-generation'} as NativeRegistration;
  rows.set('stream-token',JSON.stringify({registration,request:JSON.stringify({type:'relay.subscribe',id:'subscribe',subId:'caller',filters:[{kinds:[1]}]})}));
  binding.receive({type:'capability',sessionId:registration.sessionId,generation:registration.generation,token:'stream-token',lane:'subscription'});
  assert.equal(calls.length,1);
  const key=new Uint8Array(32);key[31]=1;
  const event=finalizeEvent({kind:1,created_at:100,content:'normal owner test',tags:[]},key);
  const frame=(index:number)=>calls[index]!.frame(JSON.stringify(['EVENT',calls[index]!.sub,event]));
  frame(0);assert.equal(deliveries.length,1);
  workspace.change(focusNapplet(workspace.getSnapshot().workspace,h.primary.id));await workspace.flush();
  assert.equal(calls[0]!.stopped,0);
  manager.setForeground(false);assert.equal(calls[0]!.stopped,1);
  const change=await h.transition.prepareImport();assert(change);await h.transition.confirm(change);
  await new Promise(resolve=>setTimeout(resolve,40));assert.ok(closed.has('stream-token'));
  manager.setForeground(true);assert.equal(calls.length,1);frame(0);assert.equal(deliveries.length,1);
  assert.equal(JSON.parse(owner.open(descriptor).configuration).user,pubkey(2));
});


test('normal Resource Lab owner revokes pending work on confirmed identity change and new realm refetches', {timeout:5000}, async t => {
  const h=await start(t),descriptor=h.owner.descriptor('resource-lab',7);
  const workspace=h.transition.getSnapshot().session.workspace;
  workspace.change(openNapplet(workspace.getSnapshot().workspace,descriptor));await workspace.flush();
  let calls=0,release!:(bytes:Uint8Array<ArrayBuffer>)=>void;
  const began=deferred(),body=new TextEncoder().encode('public sample');
  const service=createResourceService({servers:()=>[],sha256:async()=>'',https:async()=> {
    calls++;if(calls>1)return body;began.resolve();return new Promise(resolve=>{release=resolve;});
  }});
  t.after(()=>service.revokeAll());
  const owner=createRuntimeOwner(h.database,h.transition,h.native,undefined,undefined,undefined,undefined,{service,transfers:createResourceTransfers(()=>h.native.newInstanceId())});
  const binding=owner.open(descriptor),old=h.admit(binding,{type:'resource.bytes',id:'old',url:'https://cdn.example.org/sample'});
  const completed=deferred();h.native.onFinish=token=>{if(token===old.token)completed.resolve();};
  binding.receive(old.event);await began.promise;
  const change=await h.transition.prepareImport();assert(change);await h.transition.confirm(change);await completed.promise;
  assert.equal(h.native.results.get(old.token),null);
  release(body);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(h.native.results.get(old.token),null);
  const nextWorkspace=h.transition.getSnapshot().session.workspace;
  nextWorkspace.change(openNapplet(nextWorkspace.getSnapshot().workspace,descriptor));await nextWorkspace.flush();
  const next=owner.open(descriptor);assert.equal(JSON.parse(next.configuration).user,pubkey(2));
  const request=h.admit(next,{type:'resource.bytes',id:'fresh',url:'https://cdn.example.org/sample'},'new-resource-generation');
  const fresh=deferred();h.native.onFinish=token=>{if(token===request.token)fresh.resolve();};next.receive(request.event);await fresh.promise;
  assert.equal(calls,2);assert.equal((h.native.results.get(request.token) as {type:string;transfer:{length:number}}).transfer.length,body.length);
  assert.equal((h.native.results.get(request.token) as {type:string}).type,'resource.bytes.result');
});
