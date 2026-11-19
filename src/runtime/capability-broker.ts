import {CapabilityReadAdmission, CapabilityReadBusy} from './capability-read-admission.ts';
import {readCommon} from '../common/common-service.ts';
import {commonFailure,type CommonRequest} from '../common/common-contract.ts';
import { CATALOG_PAGE, parseCatalogPageRequest } from '../napplets/catalog-page-contract.ts';
import type { createCatalogRecommendations } from '../napplets/catalog-recommendation.ts';
import { createCatalogPaging } from '../napplets/catalog-paging.ts';
import type { OutboxReadService } from '../outbox/read-service.ts';
import { outboxReadFailure, OutboxQueryError, type OutboxReadRequest } from '../outbox/query-contract.ts';
import type { IdentityDataPort } from '../identity/identity-service.ts';
import { identityFailure, type IdentityRequest } from '../identity/identity-contract.ts';
import { createResourceBroker, type ResourceHost } from '../resources/resource-broker.ts';
import type { RelayQueryService } from '../network/native-relay-query.ts';
import type { ShellDatabase } from '../storage/database.ts';
import { ShellStorageError, type StringStorage } from '../storage/ports.ts';
import { utf8Bytes } from '../storage/codec.ts';
import { CAPABILITY_LIMITS, DEFERRED_IDENTITY_OPERATIONS, decodeNativeRegistration, decodeNativeRequest, identityResult,
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
async function operateStorage(database: ShellDatabase, registration: NativeRegistration, request: CapabilityRequest, active: () => void) {
  const {user, publisher, appId, version, instanceId} = registration;
  const binding = database.bindStorage({user, publisher, appId, version, instanceId, assertActive: active});
  try { return await operate(binding.port, request); }
  catch (error) { return storageFailure(request, storageError(error))!; }
  finally { binding.revoke(); }
}
async function readQuery(request: Extract<CapabilityRequest, {type: 'relay.query'}>, queries: RelayQueryService | undefined, pending: CapabilityReadAdmission, active: () => void, discovery: boolean): Promise<CapabilityReply> {
  if (!queries) return queryFailure(request, 'relay query unavailable or busy')!;
  try {
    const events = await pending.schedule(active, async signal => {
      const {filters} = request;
      const feedMetadata = discovery && filters.every(({kinds, authors, '#d': identifiers}) =>
        Array.isArray(kinds) && kinds.length === 1 && (kinds[0] === 0 && Array.isArray(authors) ||
          kinds[0] === 30267 && Array.isArray(identifiers) && identifiers.length === 1 && identifiers[0] === 'napplets'));
      if (!feedMetadata || !queries.queryDetailed) return queries.query(filters, signal, active);
      // Public feed samples can use verified replies from reachable Network peers.
      // A slow peer must not consume the whole read before other peers get a turn.
      const sample = await queries.queryDetailed(filters, signal, active, {completeRelays: true});
      if (sample.incomplete && !sample.events.length) throw new Error('Incomplete feed metadata read');
      return sample.events;
    });
    return {type: 'relay.query.result', id: request.id, events};
  }
  catch (error) { return queryFailure(request, error instanceof CapabilityReadBusy ? 'relay query unavailable or busy' : 'relay query failed')!; }
}
async function readOutboxQuery(request: OutboxReadRequest, service: OutboxReadService | undefined, registration: NativeRegistration, pending: CapabilityReadAdmission, active: () => void, nativeToken: string): Promise<CapabilityReply> {
  if (!service) return outboxReadFailure(request, 'policy denied')!;
  const options = {appData:registration.appData,partialAuthorRoutes:true as const};
  try {
    if (request.type === 'outbox.getEvent') {
      if (!service.getEvent) return outboxReadFailure(request,'policy denied')!;
      const result = await pending.schedule(active,signal => service.getEvent!(request,registration.user,signal,active,nativeToken,options));
      return {type:'outbox.getEvent.result',id:request.id,...result};
    }
    if (request.type === 'outbox.resolveRelays') {
      if (!service.resolveRelays) return outboxReadFailure(request,'policy denied')!;
      const result = await pending.schedule(active,signal => service.resolveRelays!(request,registration.user,signal,active));
      const {relays,source,missingAuthors} = result;
      return {type:'outbox.resolveRelays.result',id:request.id,plan:{relays,source,...(missingAuthors.length ? {missingAuthors} : {})}};
    }
    const result = await pending.schedule(active, signal => service.query(request, registration.user, signal, active, nativeToken,options));
    return {type: 'outbox.query.result', id: request.id, events: result.events, ...(result.incomplete ? {incomplete: true} : {})};
  } catch (error) {
    const allowed = ['invalid filter', 'relay timeout', 'relay list unavailable', 'policy denied', 'no authors', 'not found'];
    return outboxReadFailure(request, error instanceof CapabilityReadBusy ? 'policy denied' :
      error instanceof OutboxQueryError && allowed.includes(error.message) ? error.message : 'relay list unavailable')!;
  }
}
async function readIdentity(request: IdentityRequest, service: IdentityDataPort | undefined, registration: NativeRegistration, pending: CapabilityReadAdmission, active: () => void): Promise<CapabilityReply> {
  if (!service || request.type === 'identity.getPublicKey') return identityResult(request, registration.user);
  const deferred = DEFERRED_IDENTITY_OPERATIONS.includes(request.type);
  if (!deferred && pending.size >= 2) return identityFailure(request, 'identity data busy');
  const read = (signal: AbortSignal) => service.read(request, registration, signal, active);
  try {return await (deferred ? pending.schedule(active, read) : pending.run(active, read));}
  catch (error) {return identityFailure(request, error instanceof CapabilityReadBusy ? 'identity data busy' : 'identity data unavailable');}
}
async function readCatalog(value: unknown, paging: ReturnType<typeof createCatalogPaging>,
  recommendations: ReturnType<typeof createCatalogRecommendations> | undefined,
  seen: Set<string>, pending: CapabilityReadAdmission, active: () => void): Promise<CapabilityReply | null> {
  if (!value || typeof value !== 'object' || !('id' in value) || !('type' in value)) return null;
  const {id, type} = value;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  const page = type === CATALOG_PAGE ? parseCatalogPageRequest(value) : null;
  if (!page && !recommendations) return null;
  const key = JSON.stringify([type, id]);
  const reply = {type: type + '.result', id};
  const failure = page ? {...reply, error: 'Catalog paging unavailable'} : {...reply, result: {status: 'unavailable'}};
  if (seen.has(key) || seen.size >= CAPABILITY_LIMITS.sessionRequests || page && pending.size >= 2) return failure;
  seen.add(key);
  try {
    const work = (signal: AbortSignal) => page ? paging(page, signal, active) : recommendations!.dispatch(value, signal, active);
    const result = await (page ? pending.run(active, work) : pending.schedule(active, work));
    return {...reply, result};
  } catch {return failure;}
}
function invalidRequestReply(payload: unknown, domains: readonly string[]): CapabilityReply | null {
  const common = domains.includes('common') ? commonFailure(payload) : null;
  const relay = domains.includes('relay') ? queryFailure(payload, 'invalid relay query') : null;
  const storage = domains.includes('storage') ? storageFailure(payload, 'invalid storage request') : null;
  const outbox = domains.includes('outbox') ? outboxReadFailure(payload, 'invalid filter') : null;
  return common ?? relay ?? storage ?? outbox;
}

function finishCapability(native: NativeCapabilityPort, token: string, response: string | null, active: () => void): void {
  // A revoked owner never receives a stale successful result, even if COMMIT already finished.
  try { active(); } catch { response = null; }
  const bounded = response !== null && utf8Bytes(response) <= CAPABILITY_LIMITS.messageBytes ? response : null;
  try { native.finish(token, bounded); } catch { /* Native expiry retains the final denial boundary. */ }
}

/** One broker per registered native view. It is never passed into the WebView. */
export function createCapabilityBroker(database: ShellDatabase, native: NativeCapabilityPort, owner: CapabilityOwner, queries?: RelayQueryService, closeRelay?: (request:unknown)=>void, resources?: ResourceHost, identityData?: IdentityDataPort, outbox?: OutboxReadService, closeOutbox?: (request:unknown)=>void, discovery = false, recommendations?: ReturnType<typeof createCatalogRecommendations>) {
  const registration = decodeNativeRegistration(owner.registration);
  const expected = JSON.stringify(registration);
  const resource = resources ? createResourceBroker(resources, owner) : null;
  const catalog = discovery && registration.domains.includes('relay') && queries?.catalog ? createCatalogPaging(queries.catalog) : null;
  const seen = new Set<string>();
  let disposed = false;
  const pending = new CapabilityReadAdmission();
  const assertActive = (token: string): void => {
    if (disposed || !native.isActive(token)) throw new ShellStorageError('REVOKED');
    owner.assertActive();
  };
  return Object.freeze({
    revoke: () => { disposed = true; resource?.revoke(); seen.clear(); pending.revoke(); },
    async dispatch(token: string): Promise<void> {
      let response: string | null = null;
      let claimed = false;
      try {
        const raw = native.take(token);
        if (raw === null) return;
        claimed = true;
        const captured = decodeNativeRequest(raw);
        if (JSON.stringify(captured.registration) !== expected) return;
        assertActive(token);
        const payload = captured.request;
        const type = payload && typeof payload === 'object' && 'type' in payload ? payload.type : null;
        if (type === 'outbox.close') {
          if (registration.domains.includes('outbox')) closeOutbox?.(payload);
          return;
        }
        if (type === 'relay.close') {
          if (registration.domains.includes('relay')) closeRelay?.(payload);
          return;
        }
        if (typeof type === 'string' && type.startsWith('resource.')) {
          response = await resource?.dispatch(payload, {nativeToken: token, assertActive: () => assertActive(token)}) ?? null;
          return;
        }
        if (type === CATALOG_PAGE || type === 'relay.catalogRecommendation') {
          const result = catalog && await readCatalog(payload, catalog, recommendations, seen, pending, () => assertActive(token));
          if (result) response = JSON.stringify(result);
          return;
        }
        let request: CapabilityRequest;
        try { request = parseCapabilityRequest(payload); }
        catch {
          const failure = invalidRequestReply(payload, registration.domains);
          if (failure) response = JSON.stringify(failure);
          return;
        }
        const domain = request.type.split('.')[0]!;
        if (!registration.domains.includes(domain)) return;
        const correlation = JSON.stringify([request.type, request.id]);
        if (seen.has(correlation) || seen.size >= CAPABILITY_LIMITS.sessionRequests) {
          const failure = commonFailure(request) ?? outboxReadFailure(request, 'policy denied') ?? queryFailure(request, 'request already used or session limit reached') ?? storageFailure(request, 'request already used or session limit reached');
          if (failure) response = JSON.stringify(failure);
          return;
        }
        seen.add(correlation);
        let result: CapabilityReply;
        if (domain === 'common') {
          const work = (signal:AbortSignal) => readCommon(request as CommonRequest,registration,
            signal,() => assertActive(token),{queries,identity:identityData,outbox,token});
          try {result = request.type === 'common.getProfile' || request.type === 'common.follows'
            ? await pending.schedule(() => assertActive(token),work)
            : await work(new AbortController().signal);}
          catch {assertActive(token);result = commonFailure(request,'relay-timeout')!;}
        } else if (request.type === 'outbox.query' || request.type === 'outbox.getEvent' || request.type === 'outbox.resolveRelays') result = await readOutboxQuery(request, outbox, registration, pending, () => assertActive(token), token);
        else if (request.type === 'relay.query') result = await readQuery(request, queries, pending, () => assertActive(token), discovery && registration.fixture === 'napplet-discovery');
        else if (domain === 'identity') result = await readIdentity(request as IdentityRequest, identityData, registration, pending, () => assertActive(token));
        else result = await operateStorage(database, registration, request, () => assertActive(token));
        assertActive(token);
        response = JSON.stringify(result);
      } catch { response = null; }
      finally {
        if (claimed) finishCapability(native, token, response, () => assertActive(token));
      }
    },
  });
}
