import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { ApprovalOrigin } from '../../src/security/approval-service.ts';
import { UploadService, type UploadNativePort, type UploadLease, type TakenUpload, type UploadResult, type UploadEffects } from '../../src/uploads/upload-service.ts';
import { UploadError, UPLOAD_LIMITS } from '../../src/uploads/upload-contract.ts';
import { VaultError } from '../../src/security/identity-vault-model.ts';
import { SIGNER_FAILURE_CODES } from '../../src/security/signing-methods.ts';

const secret = new Uint8Array(32); secret[31] = 2;
const hash = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const owner = (sessionId: string, epoch = 1): ApprovalOrigin => Object.freeze({sessionId, generation: 'generation-' + sessionId, epoch,
  user: getPublicKey(secret), publisher: '11'.repeat(32), appId: 'upload-lab', version: '22'.repeat(32), instanceId: 'instance-' + sessionId});
const deferred = <T>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};};
type State = {taken: TakenUpload; bytes: Uint8Array<ArrayBuffer>; live: boolean; approved: boolean; signing: boolean; dispatched: boolean};
/** Controlled port isolates presentation races; owning native authority/TLS proofs are separate commands. */
class Native implements UploadNativePort {
  states = new Map<UploadLease, State>(); tokens = new Map<string, TakenUpload>(); results: UploadResult[] = [];
  focused: string | null = null; puts = 0; reads = 0; cancels = 0;
  putOverride: ((state: State) => Promise<unknown>) | null = null;
  async issue(token: string, identity = owner(token), bytes = new Uint8Array([1, 2, 3]), mimeType = 'application/octet-stream') {
    const lease = {}, taken: TakenUpload = Object.freeze({lease, origin: identity, uploadId: 'public-' + token,
      filename: 'file.bin', caption: 'selected attachment', request: Object.freeze({rail: 'blossom', filename: 'file.bin', caption: 'selected attachment'}), review: Object.freeze({purpose: 'blossom-upload', identity: identity.user,
        destination: 'https://files.example.org', sha256: await hash(bytes), size: bytes.length,
        mimeType, metadataPolicy: 'attachment-unchanged'})});
    this.tokens.set(token, taken); this.states.set(lease, {taken, bytes: new Uint8Array(bytes), live: true, approved: false, signing: false, dispatched: false});
    return taken;
  }
  state(lease: UploadLease) {const value = this.states.get(lease); if (!value) throw new Error('foreign lease'); return value;}
  take(token: string) {const value = this.tokens.get(token) ?? null; this.tokens.delete(token); return value;}
  signingSource(lease: UploadLease) { return { kind: 'upload' as const, token: this.state(lease).taken.uploadId }; }
  isLive(lease: UploadLease) {return this.state(lease).live;}
  mayReview(lease: UploadLease) {const value = this.state(lease); return value.live && !value.approved && value.taken.origin.sessionId === this.focused;}
  readPreview(lease: UploadLease, offset: number) {assert(this.mayReview(lease)); this.reads++; return this.state(lease).bytes.slice(offset, offset + UPLOAD_LIMITS.chunkBytes);}
  approveOnce(lease: UploadLease) {if (!this.mayReview(lease)) return false; this.state(lease).approved = true; return true;}
  isApproved(lease: UploadLease) {const value = this.state(lease); return value.live && value.approved;}
  claimSigning(lease: UploadLease) {const value = this.state(lease); if (!this.isApproved(lease) || value.signing) return false; value.signing = true; return true;}
  async put(lease: UploadLease, credential: string) {
    const value = this.state(lease); assert(value.signing && this.isApproved(lease)); assert(credential.length > 0);
    this.puts++; value.dispatched = true;
    if (this.putOverride) return this.putOverride(value);
    return {url: 'https://files.example.org/' + value.taken.review.sha256 + '.bin', sha256: value.taken.review.sha256,
      size: value.bytes.length, type: value.taken.review.mimeType, uploaded: 1};
  }
  wasDispatched(lease: UploadLease) {return this.state(lease).dispatched;}
  cancel(lease: UploadLease) {this.cancels++; this.state(lease).live = false;}
  finish(lease: UploadLease, result: UploadResult) {this.results.push(result); this.state(lease).live = false;}
}
function make(native: Native, override: Partial<UploadEffects> = {}, assertActive: (origin: ApprovalOrigin) => void = () => {}) {
  return new UploadService(native, {assertActive}, {sha256: hash, nowSeconds: () => 100,
    sign: async (snapshot, execution) => {execution.assertActive(); return JSON.parse(JSON.stringify(finalizeEvent({...snapshot.authorization,
      tags: snapshot.authorization.tags.map(tag => [...tag])}, secret)));}, ...override});
}
async function ready(service: UploadService, native: Native, token = 'one') {
  native.focused = token; service.focus(token); assert(service.enqueue(token, owner(token)));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert(service.getSnapshot().current?.previewReady); return service.getSnapshot().current!.id;
}

test('review snapshots exact native bytes and signing scope before one dispatch', async () => {
  const native = new Native(); const taken = await native.issue('one'); let signed = 0;
  const service = make(native, {sign: async (snapshot, execution) => {signed++; execution.assertActive();
    assert.equal(snapshot.destination, taken.review.destination); assert.equal(snapshot.sha256, taken.review.sha256);
    return JSON.parse(JSON.stringify(finalizeEvent({...snapshot.authorization, tags: snapshot.authorization.tags.map(tag => [...tag])}, secret)));}});
  const id = await ready(service, native); const displayed = service.getSnapshot().current!;
  const copy = displayed.copyPreview()!; copy.fill(8); assert.deepEqual([...displayed.copyPreview()!], [1,2,3]);
  const result = await service.approve(id);
  assert.equal(result.ok, true); assert.equal(result.sha256, taken.review.sha256); assert.equal(signed, 1); assert.equal(native.puts, 1);
  assert.equal(displayed.copyPreview(), null); await assert.rejects(service.approve(id));
});

test('foreground switching during delayed signing and transport preserves only the approved upload', async () => {
  const native = new Native(); await native.issue('one'); const signing = deferred<unknown>(), transfer = deferred<unknown>();
  let captured: Parameters<UploadEffects['sign']>[0] | null = null;
  const service = make(native, {sign: async snapshot => {captured = snapshot; return signing.promise;}});
  native.putOverride = async () => transfer.promise;
  const id = await ready(service, native), pending = service.approve(id);
  await new Promise<void>(resolve => setImmediate(resolve));
  native.focused = 'two'; service.focus('two'); assert.equal(service.getSnapshot().active.length, 1); assert.equal(native.cancels, 0);
  const snapshot = captured!; signing.resolve(JSON.parse(JSON.stringify(finalizeEvent({...snapshot.authorization,
    tags: snapshot.authorization.tags.map(tag => [...tag])}, secret))));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(native.puts, 1);
  transfer.resolve({url: 'https://files.example.org/' + snapshot.sha256 + '.bin', sha256: snapshot.sha256,
    size: snapshot.size, type: snapshot.mimeType, uploaded: 1});
  assert.equal((await pending).status, 'complete');
});

test('background during signing cancels without dispatch and never resumes on foreground', async () => {
  const native = new Native(); await native.issue('one'); const signer = deferred<unknown>();
  const service = make(native, {sign: async () => signer.promise});
  const id = await ready(service, native), pending = service.approve(id);
  await new Promise<void>(resolve => setImmediate(resolve)); service.background(); signer.resolve(null);
  assert.equal((await pending).status, 'cancelled'); assert.equal(native.puts, 0);
  service.foreground(); assert.equal(service.getSnapshot().active.length, 0); assert.equal(service.getSnapshot().pending, 0);
});

test('background, close and identity change after dispatch report uncertainty without retry', async () => {
  for (const action of ['background', 'close', 'identity'] as const) {
    const native = new Native(); await native.issue('one'); const transfer = deferred<unknown>(); native.putOverride = async () => transfer.promise;
    const service = make(native), id = await ready(service, native), pending = service.approve(id);
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(native.puts, 1);
    if (action === 'background') service.background(); else if (action === 'close') service.close('one'); else service.revisionChanged(2);
    assert.equal(native.results.at(-1)?.error, 'outcome unknown'); transfer.resolve({});
    assert.equal((await pending).ok, false); assert.equal(native.puts, 1); assert.equal(service.getSnapshot().active.length, 0);
    if (action !== 'background') { assert.equal(service.getSnapshot().outcomes.length, 0); assert.equal(service.hasCloseRisk('one'), false); }
    else assert.equal(service.hasCloseRisk('one'), true);
  }
});

test('native-only revocation during an awaited transport suppresses receipt success', async () => {
  const native = new Native(); const taken = await native.issue('one'); const transfer = deferred<unknown>(); native.putOverride = async () => transfer.promise;
  const service = make(native), id = await ready(service, native), pending = service.approve(id);
  await new Promise<void>(resolve => setImmediate(resolve)); native.state(taken.lease).live = false;
  transfer.resolve({url: 'https://files.example.org/' + taken.review.sha256 + '.bin', sha256: taken.review.sha256, size: 3, type: 'application/octet-stream', uploaded: 1});
  assert.equal((await pending).error, 'outcome unknown'); assert.equal(native.results.at(-1)?.ok, false);
});

test('mutated signed credentials never reach the PUT owner', async () => {
  const native = new Native(); await native.issue('one');
  const service = make(native, {sign: async snapshot => JSON.parse(JSON.stringify(finalizeEvent({...snapshot.authorization,
    tags: snapshot.authorization.tags.map(tag => [...tag]), content: 'different destination'}, secret)))});
  assert.equal((await service.approve(await ready(service, native))).ok, false); assert.equal(native.puts, 0);
});

test('malformed, changed or missing provider receipts remain unknown after dispatch', async () => {
  for (const value of [null, {}, {url: 'https://files.example.org/a.bin', sha256: '00'.repeat(32), size: 3, type: 'application/octet-stream', uploaded: 1}]) {
    const native = new Native(); await native.issue('one'); native.putOverride = async () => value;
    const service = make(native); assert.equal((await service.approve(await ready(service, native))).error, 'outcome unknown'); assert.equal(native.puts, 1);
  }
});

test('definitive provider rejections retain their reason and do not retry', async () => {
  for (const error of ['server rejected', 'file too large', 'quota exceeded'] as const) {
    const native = new Native(); await native.issue('one'); native.putOverride = async () => {throw new UploadError(error);};
    const service = make(native); assert.equal((await service.approve(await ready(service, native))).error, error); assert.equal(native.puts, 1);
  }
});

test('mismatched native origin, identity, review hash and unsanitized image never receive approval', async () => {
  const native = new Native(); const a = await native.issue('a'), b = await native.issue('b'), c = await native.issue('c');
  const service = make(native); assert.equal(service.enqueue('a', {...a.origin, publisher: 'ff'.repeat(32)}), false);
  native.tokens.set('b', {...b, review: {...b.review, identity: 'ff'.repeat(32)}}); assert.equal(service.enqueue('b', b.origin), false);
  native.tokens.set('c', {...c, review: {...c.review, mimeType: 'image/png'}}); assert.equal(service.enqueue('c', c.origin), false);
  const taken = await native.issue('one'); native.tokens.set('one', {...taken, review: {...taken.review, sha256: 'ff'.repeat(32)}});
  native.focused = 'one'; service.focus('one'); assert(service.enqueue('one', taken.origin));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(service.getSnapshot().current, null); assert.equal(native.puts, 0);
});

test('unfocused queued bytes are not inspected and duplicate realms remain denied', async () => {
  const native = new Native(); const a = await native.issue('a'), b = await native.issue('b'), c = await native.issue('c');
  const service = make(native); assert(service.enqueue('a', a.origin)); assert(service.enqueue('b', b.origin)); assert(service.enqueue('c', c.origin));
  assert.equal(native.reads, 0); native.focused = 'a'; service.focus('a'); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(native.reads, 1); service.reject(service.getSnapshot().current!.id); assert.equal(native.puts, 0);
  const duplicate = await native.issue('d', b.origin); assert.equal(service.enqueue('d', duplicate.origin), false);
});

test('preview chunks are bounded and native approval refusal prevents all signing', async () => {
  const native = new Native(); await native.issue('one', owner('one'), new Uint8Array(UPLOAD_LIMITS.chunkBytes + 1));
  let signs = 0; const service = make(native, {sign: async () => {signs++; return null;}});
  const id = await ready(service, native); assert.equal(native.reads, 2); native.approveOnce = () => false;
  assert.equal((await service.approve(id)).error, 'policy denied'); assert.equal(signs, 0); assert.equal(native.puts, 0);
});

test('terminal finish revokes authority before observers without a competing cancel receipt', async () => {
  const native = new Native(); await native.issue('one');
  const service = make(native), id = await ready(service, native);
  service.reject(id);
  assert.equal(native.cancels, 0); assert.equal(native.results.length, 1);
  assert.equal(native.results[0]!.status, 'cancelled'); assert.equal(service.getSnapshot().pending, 0);
});

test('failed progress registration does not retain a hidden pending review', async () => {
  const native = new Native(); await native.issue('one');
  Object.assign(native, {observeProgress() {throw Error('Listener unavailable');}});
  const service = make(native); service.focus('one');
  assert.equal(service.enqueue('one', owner('one')), false);
  assert.equal(service.getSnapshot().pending, 0); assert.equal(service.getSnapshot().current, null);
  assert.equal(native.puts, 0); assert.equal(native.cancels, 1);
});

test('two active transfers coexist with eight waiting reviews and focus cannot mint a third active grant', async () => {
  const native = new Native(), held = deferred<unknown>(); native.putOverride = () => held.promise;
  const service = make(native);
  await native.issue('first'); const first = service.approve(await ready(service, native, 'first'));
  await new Promise<void>(resolve => setImmediate(resolve));
  await native.issue('second'); const second = service.approve(await ready(service, native, 'second'));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(service.getSnapshot().active.length, 2);
  for (let index = 0; index < 8; index++) {const taken = await native.issue('waiting' + index); assert(service.enqueue('waiting' + index, taken.origin));}
  const overflow = await native.issue('overflow'); assert.equal(service.enqueue('overflow', overflow.origin), false);
  native.focused = 'waiting0'; service.focus('waiting0'); assert.equal(service.getSnapshot().pending, 8); assert.equal(service.getSnapshot().current, null);
  assert.equal(native.puts, 2); service.cancel(service.getSnapshot().active[0]!.id);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(service.getSnapshot().active.length, 1); assert(service.getSnapshot().current?.previewReady);
  service.background(); held.resolve(null); await Promise.all([first,second]); assert.equal(service.getSnapshot().pending, 0); assert.equal(service.getSnapshot().active.length, 0);
});


test('unchanged review and active polling retain snapshots without hiding cancellation', async () => {
  const native = new Native(), taken = await native.issue('stable'), held = deferred<unknown>();
  native.putOverride = () => held.promise; const service = make(native); const id = await ready(service, native, 'stable');
  let updates = 0; service.subscribe(() => {updates++;}); const review = service.getSnapshot();
  for (let count = 0; count < 12; count++) service.refresh();
  assert.equal(service.getSnapshot(), review); assert.equal(updates, 0);
  const completion = service.approve(id); await new Promise<void>(resolve => setImmediate(resolve));
  const active = service.getSnapshot(), before = updates; assert.equal(active.active.length, 1);
  for (let count = 0; count < 12; count++) service.refresh();
  assert.equal(service.getSnapshot(), active); assert.equal(updates, before);
  service.cancel(id); assert.equal(service.getSnapshot().active.length, 0); assert(updates > before);
  held.resolve(null); await completion; assert.equal(service.getSnapshot().outcomes.at(-1)?.result.error, 'outcome unknown');
});


test('validated WAV alias retains canonical SDK MIME and every other receipt check', async () => {
  const wav = new Uint8Array(46), view = new DataView(wav.buffer);
  for (const [at, text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']] as const) wav.set(new TextEncoder().encode(text), at);
  view.setUint32(4, 38, true); view.setUint32(16, 16, true); view.setUint32(40, 2, true);
  for (const mode of ['valid','invalid-body','other-mime','wrong-hash','wrong-size','wrong-url','stale']) {
    const native = new Native(), bytes = wav.slice(); if (mode === 'invalid-body') bytes[8] = 0;
    await native.issue('one', owner('one'), bytes, 'audio/wav');
    native.putOverride = async state => {
      if (mode === 'stale') state.live = false;
      return {url: 'https://files.example.org/' + (mode === 'wrong-url' ? '00'.repeat(32) : state.taken.review.sha256) + '.wav',
        sha256: mode === 'wrong-hash' ? '00'.repeat(32) : state.taken.review.sha256,
        size: state.bytes.length + (mode === 'wrong-size' ? 1 : 0), type: mode === 'other-mime' ? 'audio/mpeg' : 'audio/x-wav', uploaded: 1};
    };
    const service = make(native), result = await service.approve(await ready(service, native));
    if (mode === 'valid') {assert.equal(result.status, 'complete'); assert.equal(result.mimeType, 'audio/wav');}
    else {assert.equal(result.error, 'outcome unknown', mode); assert.equal(result.url, undefined);}
  }
});


test('dismissing an uncertain upload result retains the session close safeguard', async () => {
  const native = new Native(); await native.issue('one'); const transfer = deferred<unknown>(); native.putOverride = async () => transfer.promise;
  const service = make(native); const pending = service.approve(await ready(service, native));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(service.hasCloseRisk('one'), true);
  service.background(); transfer.resolve({}); await pending; service.foreground();
  const outcome = service.getSnapshot().outcomes[0]!; assert.equal(outcome.result.error, 'outcome unknown');
  service.dismissOutcome(outcome.id); assert.equal(service.getSnapshot().outcomes.length, 0);
  assert.equal(service.hasCloseRisk('one'), true); assert.equal(service.hasCloseRisk('other'), false);
  service.revisionChanged(2); assert.equal(service.hasCloseRisk('one'), false);
});


test('signer failures stay in trusted upload presentation and never dispatch or retry', async () => {
  for (const code of SIGNER_FAILURE_CODES) {
    const native = new Native(); await native.issue('one'); let calls = 0;
    const service = make(native, {sign: async () => {calls++; throw new VaultError(code);}});
    const id = await ready(service, native), result = await service.approve(id);
    assert.equal(result.error, 'upload failed'); assert.equal(native.puts, 0); assert.equal(calls, 1);
    assert.equal(service.getSnapshot().outcomes.at(-1)?.signingFailure, code);
    assert.deepEqual(native.results, [result]);
    assert.deepEqual(Object.keys(result).sort(), ['error', 'ok', 'rail', 'status', 'uploadId']);
    await assert.rejects(service.approve(id)); assert.equal(calls, 1);
  }
});

test('untrusted signer errors and upload transport failures cannot impersonate signer feedback', async () => {
  for (const error of [{code: 'SIGNER_UNCERTAIN', message: 'untrusted diagnostic'}, new Error('untrusted diagnostic')]) {
    const native = new Native(); await native.issue('one');
    const service = make(native, {sign: async () => {throw error;}});
    await service.approve(await ready(service, native));
    assert.equal(service.getSnapshot().outcomes.at(-1)?.signingFailure, null);
    assert.equal(JSON.stringify(service.getSnapshot()).includes('untrusted diagnostic'), false);
    assert.equal(native.puts, 0);
  }
  const native = new Native(); await native.issue('one');
  native.putOverride = async () => {throw new VaultError('SIGNER_UNCERTAIN');};
  const service = make(native), result = await service.approve(await ready(service, native));
  assert.equal(result.error, 'outcome unknown'); assert.equal(native.puts, 1);
  assert.equal(service.getSnapshot().outcomes.at(-1)?.signingFailure, null);
});

test('cancelling an outstanding signature retains its uncertainty without sending the file', async () => {
  for (const action of ['cancel', 'background'] as const) {
    const native = new Native(); await native.issue('one'); const signing = deferred<unknown>();
    const service = make(native, {sign: async () => signing.promise});
    const id = await ready(service, native), pending = service.approve(id);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (action === 'cancel') service.cancel(id); else service.background();
    const outcome = service.getSnapshot().outcomes.at(-1)!;
    assert.equal(outcome.signingFailure, 'SIGNER_UNCERTAIN');
    assert.equal(outcome.result.status, 'cancelled'); assert.equal(native.puts, 0);
    signing.resolve(null); assert.equal(await pending, outcome.result);
    assert.equal(native.results.length, 1); assert.equal(native.puts, 0);
    assert.equal(service.getSnapshot().outcomes.at(-1), outcome);
    service.foreground(); assert.equal(service.getSnapshot().active.length, 0);
  }
});

test('cancellation before signing starts has no signer uncertainty', async () => {
  const native = new Native(); await native.issue('one'); const hashing = deferred<string>();
  let hashes = 0, signs = 0;
  const service = make(native, {sha256: async bytes => ++hashes === 1 ? hash(bytes) : hashing.promise,
    sign: async () => {signs++; return null;}});
  const id = await ready(service, native), pending = service.approve(id);
  await new Promise<void>(resolve => setImmediate(resolve)); service.cancel(id);
  assert.equal(service.getSnapshot().outcomes.at(-1)?.signingFailure, null);
  hashing.resolve(await hash(new Uint8Array([1, 2, 3]))); await pending;
  assert.equal(signs, 0); assert.equal(native.puts, 0);
});

test('late signer failure cannot restore a dismissed result or a closed account scope', async () => {
  for (const action of ['dismiss', 'close', 'revision'] as const) {
    const native = new Native(); await native.issue('one'); const signing = deferred<unknown>();
    const service = make(native, {sign: async () => {await signing.promise; throw new VaultError('SIGNER_UNCERTAIN');}});
    const id = await ready(service, native), pending = service.approve(id);
    await new Promise<void>(resolve => setImmediate(resolve)); service.cancel(id);
    if (action === 'dismiss') service.dismissOutcome(id);
    else if (action === 'close') service.close('one'); else service.revisionChanged(2);
    signing.resolve(null); await pending;
    assert.equal(service.getSnapshot().outcomes.length, 0); assert.equal(native.results.length, 1);
    assert.equal(native.puts, 0);
  }
});


test('upload handoff retains only undispatched signing and waits for the JS foreground event', async () => {
  const native = new Native(), taken = await native.issue('one'), gate = deferred<unknown>();
  let status: 'pending' | 'resumed' | null = null, captured: Parameters<UploadEffects['sign']>[0] | null = null;
  const service = make(native, {
    handoffState(source) { assert.deepEqual(source, { kind: 'upload', token: taken.uploadId }); return status; },
    sign: async snapshot => { captured = snapshot; return gate.promise; },
  });
  const pending = service.approve(await ready(service, native));
  await new Promise<void>(resolve => setImmediate(resolve));
  status = 'pending'; native.state(taken.lease).live = false; service.background(); service.refresh();
  assert.equal(service.getSnapshot().active.length, 1); assert.equal(native.puts, 0);
  const snapshot = captured!; status = 'resumed'; native.state(taken.lease).live = true;
  gate.resolve(JSON.parse(JSON.stringify(finalizeEvent({ ...snapshot.authorization,
    tags: snapshot.authorization.tags.map(tag => [...tag]) }, secret))));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(native.puts, 0);
  service.refresh(); assert.equal(service.getSnapshot().active.length, 1); assert.equal(native.puts, 0);
  service.foreground(); assert.equal((await pending).status, 'complete'); assert.equal(native.puts, 1);
});

for (const action of ['cancel', 'close', 'revision', 'query-error', 'native-revoke', 'second-background'] as const) {
  test(`upload handoff ${action} prevents a late credential from reaching the file sender`, async () => {
    const native = new Native(), taken = await native.issue('one'), gate = deferred<unknown>();
    let status: 'pending' | 'resumed' | null = null, queryError = false;
    const service = make(native, { handoffState() { if (queryError) throw new Error('Unavailable'); return status; },
      sign: async () => gate.promise });
    const id = await ready(service, native), pending = service.approve(id);
    await new Promise<void>(resolve => setImmediate(resolve));
    status = 'pending'; native.state(taken.lease).live = false; service.background(); service.refresh();
    assert.equal(service.getSnapshot().active.length, 1);
    if (action === 'cancel') service.cancel(id);
    if (action === 'close') service.close('one');
    if (action === 'revision') service.revisionChanged(2);
    if (action === 'query-error') { queryError = true; service.refresh(); }
    if (action === 'native-revoke') { status = 'resumed'; service.foreground(); }
    if (action === 'second-background') { status = 'resumed'; native.state(taken.lease).live = true; service.foreground(); service.background(); }
    gate.resolve(null); assert.equal((await pending).ok, false); assert.equal(native.puts, 0);
    assert.equal(service.getSnapshot().active.length, 0);
  });
}


test('foreground-delivery timeout retains signer uncertainty without sending the file', async () => {
  const native = new Native(), taken = await native.issue('one'), gate = deferred<unknown>();
  let status: 'pending' | 'resumed' | null = null, captured: Parameters<UploadEffects['sign']>[0] | null = null;
  const service = make(native, { handoffState: () => status,
    sign: async snapshot => { captured = snapshot; return gate.promise; } });
  const pending = service.approve(await ready(service, native));
  await new Promise<void>(resolve => setImmediate(resolve));
  status = 'pending'; native.state(taken.lease).live = false; service.background();
  status = 'resumed'; native.state(taken.lease).live = true;
  const snapshot = captured!;
  gate.resolve(JSON.parse(JSON.stringify(finalizeEvent({ ...snapshot.authorization,
    tags: snapshot.authorization.tags.map(tag => [...tag]) }, secret))));
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(native.puts, 0); assert.equal(native.results.length, 1);
  assert.equal(service.getSnapshot().outcomes[0]?.signingFailure, 'SIGNER_UNCERTAIN');
  assert.equal(native.state(taken.lease).live, false);
});


test('upload authorization status: preparation and native signing precede transfer even with zero bytes sent', async () => {
  const native = new Native(); await native.issue('one');
  const hashing = deferred<string>(), signing = deferred<unknown>(), transfer = deferred<unknown>();
  let hashes = 0, captured: Parameters<UploadEffects['sign']>[0] | null = null;
  const service = make(native, {sha256: async bytes => ++hashes === 1 ? hash(bytes) : hashing.promise,
    sign: async snapshot => {captured = snapshot; return signing.promise;}});
  native.putOverride = async () => transfer.promise;
  const pending = service.approve(await ready(service, native));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(service.getSnapshot().active[0]?.phase, 'authorizing'); assert.equal(captured, null); assert.equal(native.puts, 0);
  hashing.resolve(await hash(new Uint8Array([1, 2, 3])));
  await new Promise<void>(resolve => setImmediate(resolve));
  const authorizing = service.getSnapshot(); assert.equal(authorizing.active[0]?.phase, 'authorizing'); assert.equal(native.puts, 0);
  const snapshot = captured!; signing.resolve(JSON.parse(JSON.stringify(finalizeEvent({...snapshot.authorization,
    tags: snapshot.authorization.tags.map(tag => [...tag])}, secret))));
  await new Promise<void>(resolve => setImmediate(resolve));
  const transferring = service.getSnapshot(); assert.notEqual(transferring, authorizing);
  assert.equal(transferring.active[0]?.phase, 'transferring'); assert.equal(transferring.active[0]?.bytesSent, 0); assert.equal(native.puts, 1);
  transfer.resolve({url: 'https://files.example.org/' + snapshot.sha256 + '.bin', sha256: snapshot.sha256,
    size: snapshot.size, type: snapshot.mimeType, uploaded: 1});
  assert.equal((await pending).status, 'complete');
});

test('upload authorization status: native denial matches cancellation without overwriting earlier source revocation', async () => {
  for (const refreshFirst of [false, true]) {
    const native = new Native(), taken = await native.issue('one'), gate = deferred<void>();
    const service = make(native, {sign: async () => {await gate.promise; throw new VaultError('AUTHORIZATION_DENIED');}});
    const pending = service.approve(await ready(service, native));
    await new Promise<void>(resolve => setImmediate(resolve));
    native.state(taken.lease).live = false;
    if (refreshFirst) service.refresh();
    const prior = service.getSnapshot().outcomes.at(-1); gate.resolve();
    const result = await pending, outcome = service.getSnapshot().outcomes.at(-1)!;
    assert.equal(result.status, 'cancelled'); assert.equal(result.error, 'user cancelled');
    assert.equal(outcome.result, result); assert.equal(native.puts, 0); assert.deepEqual(native.results, [result]);
    if (refreshFirst) {assert.equal(outcome, prior); assert.equal(outcome.signingFailure, 'SIGNER_UNCERTAIN');}
    else assert.equal(outcome.signingFailure, null);
  }
});

test('upload authorization status: denied signing with lost or possible dispatch evidence stays unknown', async () => {
  for (const evidence of ['dispatched', 'unavailable', 'malformed'] as const) {
    const native = new Native(), taken = await native.issue('one');
    const service = make(native, {sign: async () => {
      if (evidence === 'dispatched') native.state(taken.lease).dispatched = true;
      else native.wasDispatched = () => {if (evidence === 'unavailable') throw new Error('Unavailable'); return undefined as unknown as boolean;};
      throw new VaultError('AUTHORIZATION_DENIED');
    }});
    const result = await service.approve(await ready(service, native));
    assert.equal(result.status, 'failed'); assert.equal(result.error, 'outcome unknown', evidence);
    assert.equal(service.getSnapshot().outcomes.at(-1)?.result, result); assert.equal(native.puts, 0);
  }
});

test('upload authorization status: transfer failure cannot impersonate a native signing denial', async () => {
  const native = new Native(); await native.issue('one');
  native.putOverride = async state => {state.dispatched = false; throw new VaultError('AUTHORIZATION_DENIED');};
  const service = make(native), result = await service.approve(await ready(service, native));
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'upload failed'); assert.equal(native.puts, 1);
});

test('upload authorization status: cancelling the transfer-stage announcement cannot dispatch a file', async () => {
  const native = new Native(); await native.issue('one'); const service = make(native), id = await ready(service, native);
  const unsubscribe = service.subscribe(() => {if (service.getSnapshot().active[0]?.phase === 'transferring') service.cancel(id);});
  const result = await service.approve(id); unsubscribe();
  assert.equal(result.status, 'cancelled'); assert.equal(result.error, 'user cancelled');
  assert.equal(native.puts, 0); assert.deepEqual(native.results, [result]);
});
