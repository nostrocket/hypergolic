import type { OutboxReadService } from '../outbox/read-service.ts';
import { outboxReadFailure, OutboxQueryError, type OutboxReadRequest } from '../outbox/query-contract.ts';
import type { IdentityDataPort } from '../identity/identity-service.ts';
import { identityFailure, type IdentityRequest } from '../identity/identity-contract.ts';
import { createResourceBroker, type ResourceHost } from '../resources/resource-broker.ts';
import type { RelayQueryService } from '../network/native-relay-query.ts';
import type { ShellDatabase } from '../storage/database.ts';
import { ShellStorageError, type StringStorage } from '../storage/ports.ts';
import { utf8Bytes } from '../storage/codec.ts';
import { CAPABILITY_LIMITS, decodeNativeRegistration, decodeNativeRequest, identityResult,
  parseCapabilityRequest, storageFailure, queryFailure, type CapabilityReply, type CapabilityRequest,
  type NativeRegistration } from './capability-protocol.ts';

/** Native module only. take is single-use and returns a native-held immutable snapshot.
 * isActive is synchronous and checks native revocation and monotonic expiry, not an RN event mirror.
 * finish independently rechecks native view/generation before delivering the original reply. */
export interface NativeCapabilityPort {
  take(token: string): string | null;
  isActive(token: string): boolean;
  finish(token: string, response: string | null): void;
}
export interface CapabilityOwner {
  readonly registration: NativeRegistration;
  /** Must also check the selected identity epoch/revision and workspace session membership. */
  assertActive(): void;
}
function storageError(error: unknown): string {
  if (error instanceof ShellStorageError) {
    if (error.code === 'QUOTA_EXCEEDED') return 'storage quota exceeded';
    if (error.code === 'BUSY') return 'storage busy';
    if (error.code === 'STORAGE_INDETERMINATE') return 'storage result uncertain';
    if (error.code === 'INVALID_INPUT') return 'invalid storage request';
  }
  return 'storage unavailable';
}
async function operate(storage: StringStorage, request: CapabilityRequest): Promise<CapabilityReply> {
  const base = { type: `${request.type}.result`, id: request.id };
  if (!('scope' in request)) throw new Error('Storage operation required');
  switch (request.type) {
    case 'storage.get': return { ...base, value: await storage.get(request.key!, request.scope) };
    case 'storage.keys': return { ...base, keys: await storage.keys(request.scope) };
    case 'storage.set': await storage.set(request.key!, request.value!, request.scope); return base;
    case 'storage.remove': await storage.remove(request.key!, request.scope); return base;
  }
}
/** Native expiry/background can precede the React Native lifecycle mirror. */
async function watchedRead<T>(pending: Set<AbortController>, active: () => void, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  pending.add(controller);
  const watcher = setInterval(() => { try { active(); } catch { controller.abort(); } }, 25);
  try { return await read(controller.signal); }
  finally { clearInterval(watcher); pending.delete(controller); }
}
async function readQuery(request: Extract<CapabilityRequest, {type: 'relay.query'}>, queries: RelayQueryService | undefined, pending: Set<AbortController>, active: () => void): Promise<CapabilityReply> {
  if (!queries || pending.size >= 2) return queryFailure(request, 'relay query unavailable or busy')!;
  try { return {type: 'relay.query.result', id: request.id, events: await watchedRead(pending, active, signal => queries.query(request.filters, signal, active))}; }
  catch { return queryFailure(request, 'relay query failed')!; }
}
async function readOutboxQuery(request: OutboxReadRequest, service: OutboxReadService | undefined, registration: NativeRegistration, pending: Set<AbortController>, active: () => void): Promise<CapabilityReply> {
  if (!service || pending.size >= 2) return outboxReadFailure(request, 'policy denied')!;
  try {
    if (request.type === 'outbox.getEvent') {
      if (!service.getEvent) return outboxReadFailure(request,'policy denied')!;
      const result = await watchedRead(pending,active,signal => service.getEvent!(request,registration.user,signal,active));
      return {type:'outbox.getEvent.result',id:request.id,...result};
    }
    if (request.type === 'outbox.resolveRelays') {
      if (!service.resolveRelays) return outboxReadFailure(request,'policy denied')!;
      const result = await watchedRead(pending,active,signal => service.resolveRelays!(request,registration.user,signal,active));
      const {relays,source,missingAuthors} = result;
      return {type:'outbox.resolveRelays.result',id:request.id,plan:{relays,source,...(missingAuthors.length ? {missingAuthors} : {})}};
    }
    const result = await watchedRead(pending, active, signal => service.query(request, registration.user, signal, active));
    return {type: 'outbox.query.result', id: request.id, events: result.events, ...(result.incomplete ? {incomplete: true} : {})};
  } catch (error) {
    const allowed = ['invalid filter', 'relay timeout', 'relay list unavailable', 'policy denied', 'no authors', 'not found'];
    return outboxReadFailure(request, error instanceof OutboxQueryError && allowed.includes(error.message) ? error.message : 'relay list unavailable')!;
  }
}
async function readIdentity(request: IdentityRequest, service: IdentityDataPort | undefined, registration: NativeRegistration, pending: Set<AbortController>, active: () => void): Promise<CapabilityReply> {
  if (!service || request.type === 'identity.getPublicKey') return identityResult(request, registration.user);
  if (pending.size >= 2) return identityFailure(request, 'identity data busy');
  try { return await watchedRead(pending, active, signal => service.read(request, registration, signal, active)); }
  catch { return identityFailure(request, 'identity data unavailable'); }
}
/** One broker per registered native view. It is never passed into the WebView. */
export function createCapabilityBroker(database: ShellDatabase, native: NativeCapabilityPort, owner: CapabilityOwner, queries?: RelayQueryService, closeRelay?: (request:unknown)=>void, resources?: ResourceHost, identityData?: IdentityDataPort, outbox?: OutboxReadService, closeOutbox?: (request:unknown)=>void) {
  const registration = decodeNativeRegistration(owner.registration);
  const expected = JSON.stringify(registration);
  const resource = resources ? createResourceBroker(resources, owner) : null;
  const seen = new Set<string>();
  let disposed = false;
  const pending = new Set<AbortController>();
  const assertActive = (token: string): void => {
    if (disposed || !native.isActive(token)) throw new ShellStorageError('REVOKED');
    owner.assertActive();
  };
  return Object.freeze({
    revoke: () => { disposed = true; resource?.revoke(); seen.clear(); for (const query of pending) query.abort(); pending.clear(); },
    async dispatch(token: string): Promise<void> {
      let response: string | null = null;
      let claimed = false;
      let release: (() => void) | undefined;
      try {
        const raw = native.take(token);
        if (raw === null) return;
        claimed = true;
        const captured = decodeNativeRequest(raw);
        if (JSON.stringify(captured.registration) !== expected) return;
        assertActive(token);
        if (captured.request && typeof captured.request === 'object' && 'type' in captured.request && captured.request.type === 'outbox.close') {
          if(registration.domains.includes('outbox')&&registration.domains.includes('relay'))closeOutbox?.(captured.request);
          return;
        }
        if (captured.request && typeof captured.request === 'object' && 'type' in captured.request && captured.request.type === 'relay.close') {
          if (registration.domains.includes('relay')) closeRelay?.(captured.request);
          return;
        }
        if (captured.request && typeof captured.request === 'object' && 'type' in captured.request &&
          typeof captured.request.type === 'string' && captured.request.type.startsWith('resource.')) {
          response = await resource?.dispatch(captured.request, {nativeToken: token, assertActive: () => assertActive(token)}) ?? null;
          return;
        }
        let request: CapabilityRequest;
        try { request = parseCapabilityRequest(captured.request); }
        catch {
          const failure = registration.domains.includes('relay') ? queryFailure(captured.request, 'invalid relay query') : null;
          const storage = registration.domains.includes('storage') ? storageFailure(captured.request, 'invalid storage request') : null;
          const outboxFailure = registration.domains.includes('outbox') && registration.domains.includes('relay') ? outboxReadFailure(captured.request, 'invalid filter') : null;
          if (failure || storage || outboxFailure) response = JSON.stringify(failure ?? storage ?? outboxFailure);
          return;
        }
        const domain = request.type.split('.')[0]!;
        if (!registration.domains.includes(domain) || (domain === 'outbox' && !registration.domains.includes('relay'))) return;
        const correlation = JSON.stringify([request.type, request.id]);
        if (seen.has(correlation) || seen.size >= CAPABILITY_LIMITS.sessionRequests) {
          const failure = outboxReadFailure(request, 'policy denied') ?? queryFailure(request, 'request already used or session limit reached') ?? storageFailure(request, 'request already used or session limit reached');
          if (failure) response = JSON.stringify(failure);
          return;
        }
        seen.add(correlation);
        let result: CapabilityReply;
        if (request.type === 'outbox.query' || request.type === 'outbox.getEvent' || request.type === 'outbox.resolveRelays') result = await readOutboxQuery(request, outbox, registration, pending, () => assertActive(token));
        else if (request.type === 'relay.query') result = await readQuery(request, queries, pending, () => assertActive(token));
        else if (domain === 'identity') result = await readIdentity(request as IdentityRequest, identityData, registration, pending, () => assertActive(token));
        else {
          const binding = database.bindStorage({ user: registration.user, publisher: registration.publisher,
            appId: registration.appId, version: registration.version, instanceId: registration.instanceId,
            assertActive: () => assertActive(token) });
          release = binding.revoke;
          try { result = await operate(binding.port, request); }
          catch (error) { result = storageFailure(request, storageError(error))!; }
        }
        assertActive(token);
        response = JSON.stringify(result);
        if (utf8Bytes(response) > CAPABILITY_LIMITS.messageBytes) response = null;
      } catch { response = null; }
      finally {
        release?.();
        // A revoked owner never receives a stale successful result, even if COMMIT already finished.
        if (claimed) {
          try { assertActive(token); } catch { response = null; }
          try { native.finish(token, response); } catch { /* Native expiry retains the final denial boundary. */ }
        }
      }
    },
  });
}
