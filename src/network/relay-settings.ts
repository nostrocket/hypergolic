export type RelayRole = 'network' | 'lookup';
export type RelaySettingsSnapshot = Readonly<{
  networkRelays: readonly string[];
  lookupRelays: readonly string[];
}>;

export interface RelaySettingsStoragePort {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export type RelaySettingsErrorCode = 'INVALID_RELAY_URL' | 'DUPLICATE_RELAY' | 'INVALID_PERSISTED_SETTINGS' | 'INVALID_RELAY_ROLE' | 'RELAY_LIMIT_EXCEEDED';

export class RelaySettingsError extends Error {
  readonly code: RelaySettingsErrorCode;
  constructor(code: RelaySettingsErrorCode) {
    super(code);
    this.code = code;
    this.name = 'RelaySettingsError';
  }
}

export const RELAY_SETTINGS_STORAGE_KEY = 'trusted-relay-settings-v1';
export const MAX_RELAY_URL_BYTES = 2048;
export const MAX_RELAYS_PER_ROLE = 16;

// Kept aligned with src/config/default-relays.json; the service test asserts that source of truth.
const defaultsRecord = {
  networkRelays: [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://bucket.coracle.social',
  ],
  lookupRelays: [
    'wss://purplepag.es',
    'wss://relay.damus.io',
    'wss://nos.lol',
  ],
};
const fail = (code: RelaySettingsErrorCode): never => { throw new RelaySettingsError(code); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const utf8Length = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
};
function assertRole(role: unknown): asserts role is RelayRole {
  if (role !== 'network' && role !== 'lookup') fail('INVALID_RELAY_ROLE');
}

/**
 * Accepts a secure WebSocket URL with a public DNS hostname. Hostname checks are
 * structural; callers that need to defend against DNS rebinding must also apply
 * their platform's resolver and connection-time address policy.
 */
export function normalizeRelayUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || utf8Length(value) > MAX_RELAY_URL_BYTES ||
    value !== value.trim() || /[\u0000-\u0020\u007f?#]/.test(value)) {
    return fail('INVALID_RELAY_URL');
  }

  let url: URL;
  try { url = new URL(value); } catch { return fail('INVALID_RELAY_URL'); }
  const authorityStart = value.indexOf('://') + 3;
  const slashAfterAuthority = value.indexOf('/', authorityStart);
  const inputAuthority = value.slice(authorityStart, slashAfterAuthority < 0 ? value.length : slashAfterAuthority);
  if (url.protocol !== 'wss:' || url.username !== '' || url.password !== '' || inputAuthority.includes('@') ||
    url.search !== '' || url.hash !== '') return fail('INVALID_RELAY_URL');

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.length === 0 || hostname.length > 253 || hostname.includes(':') || hostname.startsWith('[') || hostname.includes('%')) {
    return fail('INVALID_RELAY_URL');
  }
  // URL canonicalizes unusual numeric IPv4 forms too. Require a DNS name, never
  // an IP literal, so private and loopback address ranges cannot pass as relays.
  if (/^[0-9.]+$/.test(hostname) || hostname.split('.').length < 2) return fail('INVALID_RELAY_URL');

  const labels = hostname.split('.');
  if (labels.some((label) => label.length === 0 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return fail('INVALID_RELAY_URL');
  const blockedSuffixes = [
    'localhost', 'local', 'localdomain', 'lan', 'internal', 'home', 'home.arpa',
    'test', 'example', 'invalid', 'onion', 'arpa',
  ];
  if (blockedSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    return fail('INVALID_RELAY_URL');
  }
  if (/^[0-9]+$/.test(labels.at(-1)!)) return fail('INVALID_RELAY_URL');

  const authority = `${hostname}${url.port === '' ? '' : `:${url.port}`}`;
  const path = url.pathname === '/' ? '' : url.pathname;
  const normalized = `wss://${authority}${path}`;
  if (utf8Length(normalized) > MAX_RELAY_URL_BYTES) return fail('INVALID_RELAY_URL');
  return normalized;
}

function freezeSnapshot(networkRelays: readonly string[], lookupRelays: readonly string[]): RelaySettingsSnapshot {
  return Object.freeze({
    networkRelays: Object.freeze([...networkRelays]),
    lookupRelays: Object.freeze([...lookupRelays]),
  });
}

function normalizeList(value: unknown, code: RelaySettingsErrorCode): string[] {
  if (!Array.isArray(value) || value.length > MAX_RELAYS_PER_ROLE) return fail(code);
  const normalized = value.map((relay) => {
    try { return normalizeRelayUrl(relay); } catch { return fail(code); }
  });
  if (new Set(normalized).size !== normalized.length) return fail(code);
  return normalized;
}

function normalizeSettings(value: unknown, code: RelaySettingsErrorCode): RelaySettingsSnapshot {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.schemaVersion !== 1 ||
    !Object.hasOwn(value, 'networkRelays') || !Object.hasOwn(value, 'lookupRelays')) return fail(code);
  return freezeSnapshot(
    normalizeList(value.networkRelays, code),
    normalizeList(value.lookupRelays, code),
  );
}

const DEFAULTS = normalizeSettings({ schemaVersion: 1, ...defaultsRecord }, 'INVALID_PERSISTED_SETTINGS');

export interface RelaySettingsService {
  getSettings(): RelaySettingsSnapshot;
  addRelay(role: RelayRole, url: string): Promise<RelaySettingsSnapshot>;
  removeRelay(role: RelayRole, url: string): Promise<RelaySettingsSnapshot>;
  restoreDefaults(role?: RelayRole): Promise<RelaySettingsSnapshot>;
}

/** Loads once, seeds shipped defaults only when storage has no value, and persists each edit. */
export async function openRelaySettings(storage: RelaySettingsStoragePort): Promise<RelaySettingsService> {
  const stored = await storage.getItem(RELAY_SETTINGS_STORAGE_KEY);
  let settings: RelaySettingsSnapshot;
  if (stored === null) {
    settings = DEFAULTS;
    await storage.setItem(RELAY_SETTINGS_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, ...settings }));
  } else {
    try { settings = normalizeSettings(JSON.parse(stored) as unknown, 'INVALID_PERSISTED_SETTINGS'); }
    catch (error) {
      if (error instanceof RelaySettingsError && error.code === 'INVALID_PERSISTED_SETTINGS') throw error;
      return fail('INVALID_PERSISTED_SETTINGS');
    }
  }

  let writes: Promise<void> = Promise.resolve();
  const commit = (change: (current: RelaySettingsSnapshot) => RelaySettingsSnapshot): Promise<RelaySettingsSnapshot> => {
    const operation = writes.then(async () => {
      const next = change(settings);
      if (next === settings) return settings;
      await storage.setItem(RELAY_SETTINGS_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, ...next }));
      settings = next;
      return settings;
    });
    writes = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const select = (current: RelaySettingsSnapshot, role: RelayRole): readonly string[] =>
    role === 'network' ? current.networkRelays : current.lookupRelays;
  const withRole = (current: RelaySettingsSnapshot, role: RelayRole, relays: readonly string[]): RelaySettingsSnapshot =>
    role === 'network'
      ? freezeSnapshot(relays, current.lookupRelays)
      : freezeSnapshot(current.networkRelays, relays);

  return Object.freeze({
    getSettings: () => freezeSnapshot(settings.networkRelays, settings.lookupRelays),
    addRelay: (role: RelayRole, value: string) => {
      assertRole(role);
      const url = normalizeRelayUrl(value);
      return commit((current) => {
        const relays = select(current, role);
        if (relays.includes(url)) return fail('DUPLICATE_RELAY');
        if (relays.length >= MAX_RELAYS_PER_ROLE) return fail('RELAY_LIMIT_EXCEEDED');
        return withRole(current, role, [...relays, url]);
      });
    },
    removeRelay: (role: RelayRole, value: string) => {
      assertRole(role);
      const url = normalizeRelayUrl(value);
      return commit((current) => {
        const relays = select(current, role);
        if (!relays.includes(url)) return current;
        return withRole(current, role, relays.filter((relay) => relay !== url));
      });
    },
    restoreDefaults: (role?: RelayRole) => {
      if (role !== undefined) assertRole(role);
      return commit((current) => {
        if (role === undefined) return DEFAULTS;
        return withRole(current, role, select(DEFAULTS, role));
      });
    },
  });
}
