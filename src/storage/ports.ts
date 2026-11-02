export type { SQLiteConnection, SQLiteModule, SQLiteValue } from './sqlite.ts';
export type StorageCode = 'INVALID_INPUT' | 'CORRUPT_STORAGE' | 'STORAGE_FAILURE' | 'STORAGE_INDETERMINATE'
  | 'REVOKED' | 'CANCELLED' | 'BUSY' | 'QUOTA_EXCEEDED' | 'CONFLICT' | 'TARGET_RETAINED' | 'SELECTION_MISMATCH';
export class ShellStorageError extends Error {
  readonly code: StorageCode;
  constructor(code: StorageCode) { super(code); this.name = 'ShellStorageError'; this.code = code; }
}
export function fail(code: StorageCode): never { throw new ShellStorageError(code); }
export function sanitize(error: unknown): ShellStorageError {
  return error instanceof ShellStorageError ? error : new ShellStorageError('STORAGE_FAILURE');
}
export const LIMITS = Object.freeze({ namespaceBytes: 512 * 1024, keys: 256, keyBytes: 1024,
  valueBytes: 256 * 1024, bindingRequests: 16, totalRequests: 128, workspaceBytes: 512 * 1024 });
export type Scope = 'shared' | 'instance';
export interface RequestOptions { readonly signal?: AbortSignal }
/** Native registry checks generation, identity epoch, expiry, current source and capability here. */
export interface TrustedUser { readonly user: string; readonly assertActive: () => void }
export interface TrustedApp extends TrustedUser { readonly publisher: string; readonly appId: string }
export interface TrustedRegistration extends TrustedApp { readonly version: string; readonly instanceId: string }
/** Exact NAP capability-domain identifiers granted for one identity, publisher and app. */
export interface AccessGrant { readonly revision: number; readonly domains: readonly string[]; readonly supportReview?: string }
export interface StringStorage {
  get(key: string, scope?: Scope, options?: RequestOptions): Promise<string | null>;
  set(key: string, value: string, scope?: Scope, options?: RequestOptions): Promise<void>;
  remove(key: string, scope?: Scope, options?: RequestOptions): Promise<void>;
  keys(scope?: Scope, options?: RequestOptions): Promise<readonly string[]>;
}
export interface Binding<T> { readonly port: T; revoke(): void }
