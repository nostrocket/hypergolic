import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadRecoveryService, type UploadRecoveryRecord } from '../../src/uploads/upload-recovery.ts';
const identity = 'a'.repeat(64);
const row = (uploadId = '00000000-0000-0000-0000-000000000001'): UploadRecoveryRecord => Object.freeze({uploadId, identity, publisher: 'b'.repeat(64), appId: 'app',
  destination: 'https://files.example.org', sha256: 'c'.repeat(64), mimeType: 'text/plain', size: 3, state: 'unknown'});
const deferred = () => {let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(done => {resolve = done;}); return {promise, resolve};};

test('restart metadata is listed without network reads and only native-retained matching results settle the UI', async () => {
  let records = [row()], reads = 0;
  const service = new UploadRecoveryService({list: () => ({available: true, identity, records}), check: async uploadId => {
    reads++; records = [{...records[0]!, state: 'present'}]; return {uploadId, state: 'present'};
  }}, () => identity);
  service.foreground(); assert.equal(reads, 0); assert.equal(service.getSnapshot().records[0]?.state, 'unknown');
  await service.check(records[0]!.uploadId); assert.equal(reads, 1); assert.equal(service.getSnapshot().records[0]?.state, 'present');
  assert.equal(service.getSnapshot().feedback[records[0]!.uploadId], 'present'); await service.check(records[0]!.uploadId); assert.equal(reads, 1);
});

test('a claimed present response cannot erase a still-unresolved native record', async () => {
  const saved = row(), service = new UploadRecoveryService({list: () => ({available: true, identity, records: [saved]}),
    check: async uploadId => ({uploadId, state: 'present'})}, () => identity);
  await service.check(saved.uploadId); assert.equal(service.getSnapshot().records[0]?.state, 'unknown'); assert.equal(service.getSnapshot().feedback[saved.uploadId], 'unknown');
});

test('late results after background or identity change cannot restore stale presentation', async () => {
  for (const change of ['background','identity'] as const) {
    let current: string | null = identity; const held = deferred(), saved = row();
    const service = new UploadRecoveryService({list: () => ({available: true, identity, records: [saved]}), check: () => held.promise}, () => current);
    const pending = service.check(saved.uploadId); assert.deepEqual(service.getSnapshot().checking, [saved.uploadId]);
    if (change === 'background') service.background(); else { current = 'd'.repeat(64); service.refresh(); }
    held.resolve({uploadId: saved.uploadId, state: 'present'}); await pending;
    assert.deepEqual(service.getSnapshot().records, []); assert.deepEqual(service.getSnapshot().checking, []); assert.deepEqual(service.getSnapshot().feedback, {});
  }
});

test('recovery never broadens malformed metadata, wrong identity, provider or duplicate records', () => {
  for (const records of [[{...row(), identity: 'd'.repeat(64)}], [{...row(), destination: 'https://FILES.example.org/'}], [row(),row()], [{...row(), size: UPLOAD_OVERSIZE}], [{...row(), credential: 'unwanted'}]]) {
    let reads = 0; const service = new UploadRecoveryService({list: () => ({available: true, identity, records}), check: async () => {reads++; return {}; }}, () => identity);
    service.refresh(); assert.equal(service.getSnapshot().available, false); assert.deepEqual(service.getSnapshot().records, []); assert.equal(reads, 0);
  }
});
const UPLOAD_OVERSIZE = 10 * 1024 * 1024 + 1;

test('two checks are bounded and duplicate clicks cannot issue another read', async () => {
  const records = [row(),row('00000000-0000-0000-0000-000000000002'),row('00000000-0000-0000-0000-000000000003')], held = deferred(); let reads = 0;
  const service = new UploadRecoveryService({list: () => ({available: true, identity, records}), check: () => {reads++; return held.promise;}}, () => identity);
  const first = service.check(records[0]!.uploadId), second = service.check(records[1]!.uploadId);
  await service.check(records[0]!.uploadId); await service.check(records[2]!.uploadId); assert.equal(reads, 2);
  held.resolve({uploadId: records[0]!.uploadId, state: 'unknown'}); await Promise.all([first,second]); assert.deepEqual(service.getSnapshot().checking, []);
  assert(records.every((_, index) => service.getSnapshot().records[index]?.state === 'unknown'));
});


test('close safeguards read persisted uncertainty for the same application without dispatch or retry', () => {
  let records: UploadRecoveryRecord[] = [row()], reads = 0;
  const service = new UploadRecoveryService({list: () => ({available: true, identity, records}), check: async () => {reads++; return {}; }}, () => identity);
  assert.equal(service.hasUnresolvedOutcome('b'.repeat(64), 'app'), true);
  assert.equal(service.hasUnresolvedOutcome('b'.repeat(64), 'other'), false);
  assert.equal(service.hasUnresolvedOutcome('d'.repeat(64), 'app'), false);
  records = [{...row(), state: 'confirmed'}]; assert.equal(service.hasUnresolvedOutcome('b'.repeat(64), 'app'), false);
  service.background(); assert.equal(service.hasUnresolvedOutcome('b'.repeat(64), 'app'), true);
  service.foreground(); assert.equal(service.hasUnresolvedOutcome('b'.repeat(64), 'app'), false); assert.equal(reads, 0);
});
test('missing or malformed persistent upload evidence cannot permit clean close', () => {
  const service = new UploadRecoveryService({list: () => {throw Error('unavailable');}, check: async () => ({})}, () => identity);
  assert.equal(service.hasUnresolvedOutcome('b'.repeat(64), 'app'), true);
});
