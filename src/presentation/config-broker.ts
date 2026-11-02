import {decodeNativeRegistration, decodeNativeRequest, CAPABILITY_LIMITS, type NativeRegistration} from '../runtime/capability-protocol.ts';
import type {CapabilityOwner, NativeCapabilityPort} from '../runtime/capability-broker.ts';
import type {RoutingNativePort} from '../routing/routing-port.ts';
import {routingPayload, routingRecord, routingText} from '../routing/routing-contract.ts';
import {ShellStorageError, type TrustedRegistration} from '../storage/ports.ts';
import {parseConfigMessage, type ConfigMessage} from './config-contract.ts';
import {captureConfigSchema, configSecretFields, configValueValid, configValuesConform, resolveConfigValues, ConfigSchemaError, type ConfigSchema, type ConfigValues, type ConfigValue} from './config-schema.ts';
import type {ConfigRecord, ConfigStore} from './config-store.ts';
type Endpoint = {origin: NativeRegistration; assertActive(): void; seen: Set<string>; tail: Promise<unknown>; schema: ConfigSchema | null; version?: number; subscription: object | null; window: number; opens: number};
export type ConfigReview = Readonly<{id: string; origin: NativeRegistration; schema: ConfigSchema; reviewRevision: number; ordinary: ConfigValues; secretPresent: Readonly<Record<string, boolean>>; section?: string}>;
export type ConfigSnapshot = Readonly<{review: ConfigReview | null}>;
const sameScope = (left: NativeRegistration, right: NativeRegistration) => left.user === right.user && left.publisher === right.publisher && left.appId === right.appId && left.version === right.version;
function valueAt(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const key of path) {if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, key)) return undefined; value = (value as Record<string, unknown>)[key];}
  return value;
}
function put(root: Record<string, unknown>, path: readonly string[], value: unknown) {
  let node = root;
  for (const key of path.slice(0, -1)) {const old = node[key]; if (old === null || typeof old !== 'object' || Array.isArray(old)) {if (value === undefined) return; node[key] = {};} node = node[key] as Record<string, unknown>;}
  if (value === undefined) delete node[path[path.length - 1]!]; else node[path[path.length - 1]!] = value;
}
function ordinary(schema: ConfigSchema, values: unknown): ConfigValues {
  const result = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
  for (const field of configSecretFields(schema)) put(result, field.path, undefined);
  return routingPayload(result) as ConfigValues;
}
function resolved(schema: ConfigSchema, record: ConfigRecord): ConfigValues {
  const result = JSON.parse(JSON.stringify(ordinary(schema, record.ordinary))) as Record<string, unknown>;
  for (const field of configSecretFields(schema)) {const value = record.secrets[JSON.stringify(field.path)]; if (configValueValid(field.schema, value)) put(result, field.path, value);}
  return resolveConfigValues(schema, result);
}
function cleaned(schema: ConfigSchema, record: ConfigRecord): ConfigRecord {
  const secrets: Record<string, ConfigValue> = {};
  for (const field of configSecretFields(schema)) {const key = JSON.stringify(field.path), value = record.secrets[key]; if (configValueValid(field.schema, value)) secrets[key] = value!;}
  return Object.freeze({format: 1, ordinary: ordinary(schema, resolved(schema, {...record, secrets})), secrets: Object.freeze(secrets)});
}
function sections(schema: ConfigSchema): readonly string[] {
  const own = typeof schema['x-napplet-section'] === 'string' ? [schema['x-napplet-section']] : [];
  return [...own, ...Object.values(schema.properties ?? {}).flatMap(sections)];
}
/** Native sender and revision select scope, schema, live subscription and trusted shell editor. */
export class ConfigBroker {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ConfigSnapshot = Object.freeze({review: null});
  private revision = -1;
  private counter = 0;
  private stopped = false;
  private saving: string | null = null;
  private opening: {generation: string; assertActive(): void} | null = null;
  private readonly release: () => void;
  private readonly capability: NativeCapabilityPort;
  private readonly native: RoutingNativePort;
  private readonly store: ConfigStore;
  constructor(capability: NativeCapabilityPort, native: RoutingNativePort, store: ConfigStore) {
    this.capability = capability; this.native = native; this.store = store; this.release = native.subscribe(() => this.refresh());
  }
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  getSnapshot = () => this.snapshot;
  private publish(review: ConfigReview | null) {this.snapshot = Object.freeze({review}); for (const listener of this.listeners) try {listener();} catch { /* UI is not authority. */ }}
  refresh() {
    const state = this.native.state();
    if (state.revision !== this.revision) {this.revision = state.revision; this.opening = null; this.publish(null);}
    for (const [generation, endpoint] of this.endpoints) {
      if (!state.ownerAvailable || state.user !== endpoint.origin.user || state.epoch !== endpoint.origin.epoch) this.close(generation);
    }
    if (this.opening) {try {this.opening.assertActive();} catch {this.opening = null;}}
    const review = this.snapshot.review;
    if (review) {try {const endpoint = this.endpoints.get(review.origin.generation); if (!endpoint) throw new Error(); this.active(endpoint, this.revision); if (this.native.reviewRevision(review.origin.generation, this.revision) !== review.reviewRevision) throw new Error();} catch {this.publish(null);}}
  }
  private active(endpoint: Endpoint, revision: number) {
    const state = this.native.state(), origin = endpoint.origin;
    if (this.stopped || this.endpoints.get(origin.generation) !== endpoint || !state.available || state.revision !== revision || state.user !== origin.user || state.epoch !== origin.epoch || !this.native.mayDeliver(origin.generation, revision, 'config')) throw new ShellStorageError('REVOKED');
    endpoint.assertActive();
  }
  private owner(endpoint: Endpoint, check: () => void): TrustedRegistration {return Object.freeze({user: endpoint.origin.user, publisher: endpoint.origin.publisher, appId: endpoint.origin.appId, version: endpoint.origin.version, instanceId: endpoint.origin.instanceId, assertActive: check});}
  private push(endpoint: Endpoint, revision: number, message: Readonly<Record<string, unknown>>) {try {this.active(endpoint, revision); return this.native.send(endpoint.origin.generation, revision, message);} catch {return false;}}
  private error(endpoint: Endpoint, revision: number, code: string) {this.push(endpoint, revision, {type: 'config.schemaError', code, error: code === 'no-schema' ? 'No configuration schema is registered.' : 'Configuration requires valid values before delivery.'});}
  private async values(endpoint: Endpoint, revision: number, assertScopeActive?: () => void): Promise<ConfigValues | null> {
    const check = () => {this.active(endpoint, revision); assertScopeActive?.();}; check();
    const schema = endpoint.schema; if (!schema) {this.error(endpoint, revision, 'no-schema'); return null;}
    const record = await this.store.read(this.owner(endpoint, check)); check();
    const values = resolved(schema, record);
    if (!configValuesConform(schema, values)) {this.error(endpoint, revision, 'invalid-schema'); return null;}
    return values;
  }
  private async broadcast(endpoint: Endpoint, revision: number) {
    const work: Promise<void>[] = [];
    for (const target of this.endpoints.values()) {
      const subscription = target.subscription;
      if (!subscription || !target.schema || !sameScope(target.origin, endpoint.origin)) continue;
      const check = () => {this.active(target, revision); if (target.subscription !== subscription) throw new ShellStorageError('REVOKED');};
      work.push(this.values(target, revision, check).then(values => {check(); if (values !== null) this.push(target, revision, {type: 'config.values', values});}).catch(() => {if (target.subscription === subscription) this.error(target, revision, 'invalid-schema');}));
    }
    await Promise.all(work);
  }
  async open(generation: string, section?: string, assertRequestActive?: () => void): Promise<void> {
    this.refresh(); const endpoint = this.endpoints.get(generation), revision = this.revision;
    if (!endpoint?.schema || this.opening || this.snapshot.review || this.counter >= Number.MAX_SAFE_INTEGER) return;
    const schema = endpoint.schema, reviewRevision = this.native.reviewRevision(generation, revision);
    if (reviewRevision === null) throw new ShellStorageError('REVOKED');
    const opening = {generation, assertActive: () => {
      if (this.opening !== opening) throw new ShellStorageError('REVOKED');
      this.active(endpoint, revision); assertRequestActive?.();
      if (endpoint.schema !== schema || this.native.reviewRevision(generation, revision) !== reviewRevision) throw new ShellStorageError('REVOKED');
    }};
    this.opening = opening;
    try {
      opening.assertActive();
      const record = await this.store.read(this.owner(endpoint, opening.assertActive)); opening.assertActive();
      const values = resolved(schema, record), present: Record<string, boolean> = {};
      for (const field of configSecretFields(schema)) present[JSON.stringify(field.path)] = valueAt(values, field.path) !== undefined;
      this.publish(Object.freeze({id: 'config-review-' + ++this.counter, origin: endpoint.origin, schema, reviewRevision, ordinary: ordinary(schema, values), secretPresent: Object.freeze(present), ...(section && sections(schema).includes(section) ? {section} : {})}));
    } finally {if (this.opening === opening) this.opening = null;}
  }
  closeReview(id: string) {if (this.snapshot.review?.id === id) this.publish(null);}
  async commit(id: string, input: unknown, secretChanges: Readonly<Record<string, ConfigValue | null>>): Promise<void> {
    if (this.saving !== null) throw new ShellStorageError('BUSY');
    this.saving = id;
    try {await this.save(id, input, secretChanges);} finally {this.saving = null;}
  }
  private async save(id: string, input: unknown, secretChanges: Readonly<Record<string, ConfigValue | null>>): Promise<void> {
    this.refresh(); const review = this.snapshot.review;
    if (!review || review.id !== id) throw new ShellStorageError('REVOKED');
    const endpoint = this.endpoints.get(review.origin.generation), revision = this.revision;
    if (!endpoint || endpoint.schema !== review.schema) throw new ShellStorageError('REVOKED');
    const check = () => {this.active(endpoint, revision); if (this.snapshot.review !== review || this.native.reviewRevision(endpoint.origin.generation, revision) !== review.reviewRevision) throw new ShellStorageError('REVOKED');}; check();
    const values = routingRecord(routingPayload(input), [], Object.keys(input as object)), changes = routingRecord(routingPayload(secretChanges), [], Object.keys(secretChanges));
    const fields = configSecretFields(review.schema), allowed = new Map(fields.map(field => [JSON.stringify(field.path), field]));
    if (fields.some(field => valueAt(values, field.path) !== undefined) || Object.entries(changes).some(([key, value]) => !allowed.has(key) || value !== null && !configValueValid(allowed.get(key)!.schema, value))) throw new ConfigSchemaError('invalid-schema');
    await this.store.change(this.owner(endpoint, check), previous => {
      check(); const current = cleaned(review.schema, previous), secrets = {...current.secrets};
      for (const [key, value] of Object.entries(changes)) {if (value === null) delete secrets[key]; else secrets[key] = value as ConfigValue;}
      const merged = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
      for (const field of fields) {const value = secrets[JSON.stringify(field.path)]; if (value !== undefined) put(merged, field.path, value);}
      if (!configValueValid(review.schema, merged, false)) throw new ConfigSchemaError('invalid-schema');
      const next = resolved(review.schema, {format: 1, ordinary: values as ConfigValues, secrets});
      if (!configValuesConform(review.schema, next)) throw new ConfigSchemaError('invalid-schema');
      return {format: 1, ordinary: ordinary(review.schema, next), secrets};
    });
    check(); await this.broadcast(endpoint, revision); check(); this.publish(null);
  }
  private async operate(endpoint: Endpoint, request: ConfigMessage, revision: number, check: () => void): Promise<Readonly<Record<string, unknown>> | null> {
    if (request.type === 'config.registerSchema') {
      try {
        const schema = captureConfigSchema(request.schema), version = request.version ?? schema.$version;
        if (request.version !== undefined && schema.$version !== undefined && request.version !== schema.$version || endpoint.version !== undefined && version !== undefined && version < endpoint.version) throw new ConfigSchemaError('version-conflict');
        await this.store.change(this.owner(endpoint, check), current => cleaned(schema, current)); check();
        endpoint.schema = schema; endpoint.version = version;
        if (endpoint.subscription) {const values = await this.values(endpoint, revision, check); check(); if (values !== null) this.push(endpoint, revision, {type: 'config.values', values});}
        return {type: 'config.registerSchema.result', id: request.id, ok: true};
      } catch (error) {
        check();
        const code = error instanceof ConfigSchemaError ? error.code : 'invalid-schema';
        const message = error instanceof ShellStorageError ? 'Configuration storage is unavailable (' + error.code + ').' : 'Configuration schema was not applied.';
        this.push(endpoint, revision, {type: 'config.schemaError', code, error: message});
        return {type: 'config.registerSchema.result', id: request.id, ok: false, code, error: message};
      }
    }
    if (request.type === 'config.get') {const values = await this.values(endpoint, revision, check); return values === null ? null : {type: 'config.values', id: request.id, values};}
    if (request.type === 'config.unsubscribe') {endpoint.subscription = null; return null;}
    if (request.type === 'config.subscribe') {const values = await this.values(endpoint, revision, check); check(); endpoint.subscription = Object.freeze({}); if (values !== null) this.push(endpoint, revision, {type: 'config.values', values}); return null;}
    if (request.type !== 'config.openSettings') return null;
    const now = Date.now(); if (now - endpoint.window >= 60_000) {endpoint.window = now; endpoint.opens = 0;}
    if (++endpoint.opens <= 4 && this.native.mayReview(endpoint.origin.generation, revision)) await this.open(endpoint.origin.generation, request.section, check);
    return null;
  }
  async dispatch(token: string, owner: CapabilityOwner): Promise<void> {
    let claimed = false, response: string | null = null;
    try {
      const raw = this.capability.take(token); if (raw === null) return; claimed = true;
      const captured = decodeNativeRequest(raw), expected = decodeNativeRegistration(owner.registration);
      if (JSON.stringify(captured.registration) !== JSON.stringify(expected) || !expected.domains.includes('config')) return;
      const wrapper = routingRecord(captured.request, ['type', 'id', 'message', 'revision']); if (wrapper.type !== 'routing.call') return;
      const id = routingText(wrapper.id, 128); if (!Number.isSafeInteger(wrapper.revision) || (wrapper.revision as number) < 0) return;
      this.refresh(); const revision = wrapper.revision as number;
      let endpoint = this.endpoints.get(expected.generation);
      if (!endpoint) {if (this.endpoints.size >= 64) return; endpoint = {origin: expected, assertActive: owner.assertActive, seen: new Set(), tail: Promise.resolve(), schema: null, subscription: null, window: Date.now(), opens: 0}; this.endpoints.set(expected.generation, endpoint);}
      else if (JSON.stringify(endpoint.origin) !== JSON.stringify(expected)) return;
      const selected = endpoint, check = () => {if (!this.capability.isActive(token)) throw new ShellStorageError('REVOKED'); owner.assertActive(); this.active(selected, revision);}; check();
      if (selected.seen.has(id) || selected.seen.size >= CAPABILITY_LIMITS.sessionRequests) return; selected.seen.add(id);
      const request = parseConfigMessage(wrapper.message);
      const work = selected.tail.catch(() => {}).then(async () => {check(); const result = await this.operate(selected, request, revision, check); check(); return result;}); selected.tail = work;
      const result = await work; check(); response = JSON.stringify({type: 'routing.call.result', id, response: result});
    } catch { /* No native-correlated success or secret escapes a revoked owner. */ }
    finally {if (claimed) this.capability.finish(token, response);}
  }
  close(generation: string) {if (this.opening?.generation === generation) this.opening = null; this.endpoints.delete(generation); if (this.snapshot.review?.origin.generation === generation) this.publish(null);}
  stop() {this.stopped = true; this.opening = null; this.release(); this.endpoints.clear(); this.publish(null);}
}
