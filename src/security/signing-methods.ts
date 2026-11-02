import { normalizeRelayUrl } from '../network/relay-settings.ts';
import { VaultError, fields, pubkey, record, type VaultSnapshot } from './identity-vault-model.ts';

export type SigningMethodKind = 'local' | 'nip46' | 'nip55';
export type SigningMethod = Readonly<{ kind: 'local' }> | Readonly<{
  kind: 'nip46'; peerPubkey: string; relays: readonly string[];
}> | Readonly<{
  kind: 'nip55'; packageName: string; certificateSha256s: readonly string[];
}>;
export type SigningMethodsSnapshot = Readonly<{
  vaultId: string;
  revision: number;
  pubkey: string;
  selectedMethod: SigningMethodKind | null;
  methods: readonly SigningMethod[];
}>;
const METHOD_ORDER: readonly SigningMethodKind[] = ['local', 'nip46', 'nip55'];
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function signingMethodTitle(kind: SigningMethodKind): string {
  switch (kind) {
    case 'local': return 'This device';
    case 'nip46': return 'Remote signer';
    case 'nip55': return 'Android signer app';
  }
}
export function signingMethodAction(kind: SigningMethodKind): string {
  switch (kind) {
    case 'local': return 'Use local key';
    case 'nip46': return 'Use remote signer';
    case 'nip55': return 'Use Android signer app';
  }
}

/** Saved public metadata, bound to the same native record as the account snapshot. */
export function captureSigningMethods(raw: string, vault: VaultSnapshot, account: string): SigningMethodsSnapshot {
  if (typeof raw !== 'string' || raw.length > 8192) throw new VaultError('CORRUPT_METADATA');
  let input: unknown;
  try { input = JSON.parse(raw) as unknown; } catch { throw new VaultError('CORRUPT_METADATA'); }
  const value = record(input);
  fields(value, ['vaultId', 'revision', 'pubkey', 'selectedMethod', 'methods']);
  if (value.vaultId !== vault.vaultId || value.revision !== vault.revision || value.pubkey !== account ||
      !vault.identities.some(identity => identity.pubkey === account) ||
      ![null, ...METHOD_ORDER].includes(value.selectedMethod as SigningMethodKind | null) ||
      !Array.isArray(value.methods) || value.methods.length > 3) throw new VaultError('CORRUPT_METADATA');
  const methods: SigningMethod[] = value.methods.map(inputMethod => {
    const method = record(inputMethod);
    if (method.kind === 'local') {
      fields(method, ['kind']);
      return Object.freeze({ kind: 'local' });
    }
    if (method.kind === 'nip55') {
      fields(method, ['kind', 'packageName', 'certificateSha256s']);
      if (typeof method.packageName !== 'string' || method.packageName.length > 255 || method.packageName !== method.packageName.trim() || !PACKAGE_NAME.test(method.packageName) ||
          !Array.isArray(method.certificateSha256s) || method.certificateSha256s.length < 1 || method.certificateSha256s.length > 16) {
        throw new VaultError('CORRUPT_METADATA');
      }
      const certificates = method.certificateSha256s;
      if (certificates.some((hash, index) => !pubkey(hash) || hash.length !== 64 || (index > 0 && certificates[index - 1] >= hash))) {
        throw new VaultError('CORRUPT_METADATA');
      }
      return Object.freeze({ kind: 'nip55', packageName: method.packageName, certificateSha256s: Object.freeze([...certificates] as string[]) });
    }
    fields(method, ['kind', 'peerPubkey', 'relays']);
    if (method.kind !== 'nip46' || !pubkey(method.peerPubkey) || !Array.isArray(method.relays) ||
        method.relays.length < 1 || method.relays.length > 3) throw new VaultError('CORRUPT_METADATA');
    const inputRelays = method.relays;
    let relays: string[];
    try { relays = inputRelays.map(normalizeRelayUrl); } catch { throw new VaultError('CORRUPT_METADATA'); }
    if (new Set(relays).size !== relays.length || relays.some((relay, index) => relay !== inputRelays[index])) {
      throw new VaultError('CORRUPT_METADATA');
    }
    return Object.freeze({ kind: 'nip46', peerPubkey: method.peerPubkey, relays: Object.freeze(relays) });
  });
  if (methods.some((method, index) => index > 0 && METHOD_ORDER.indexOf(methods[index - 1].kind) >= METHOD_ORDER.indexOf(method.kind)) ||
      (value.selectedMethod !== null && !methods.some(method => method.kind === value.selectedMethod))) {
    throw new VaultError('CORRUPT_METADATA');
  }
  return Object.freeze({ vaultId: vault.vaultId, revision: vault.revision, pubkey: account,
    selectedMethod: value.selectedMethod as SigningMethodKind | null, methods: Object.freeze(methods) });
}

export const SIGNER_FAILURE_CODES = Object.freeze([
  'INVALID_SIGNER_CONNECTION', 'SIGNER_ALREADY_CONNECTED', 'SIGNER_UNAVAILABLE', 'SIGNER_REJECTED',
  'SIGNER_RELAYS_CHANGED', 'SIGNER_EXPIRED', 'SIGNER_RESPONSE_INVALID', 'SIGNER_UNCERTAIN', 'SIGNER_UNSUPPORTED', 'LOCAL_KEY_UNAVAILABLE',
  'SIGNER_IDENTITY_CHANGED', 'SIGNER_APP_FAILED',
 ] as const);
export type SignerFailureCode = typeof SIGNER_FAILURE_CODES[number];
export function isSignerFailureCode(code: unknown): code is SignerFailureCode {
  return typeof code === 'string' && SIGNER_FAILURE_CODES.some(known => known === code);
}

export function signerFailureMessage(code: unknown): string {
  switch (code) {
    case 'INVALID_SIGNER_CONNECTION': return 'This signer connection could not be verified. Check its connection link.';
    case 'SIGNER_ALREADY_CONNECTED': return 'This account already has this signing method. Disconnect it before connecting another.';
    case 'SIGNER_UNAVAILABLE': return 'Your signer is unavailable. Reconnect it or choose a signing method.';
    case 'SIGNER_RELAYS_CHANGED': return 'Your signer changed its relays. Open Signing method in Settings and check for relay changes.';
    case 'SIGNER_REJECTED': return 'Your signer declined this request.';
    case 'SIGNER_EXPIRED': return 'This request expired. Review a new request to try again.';
    case 'SIGNER_RESPONSE_INVALID': return 'Your signer returned a response that could not be verified.';
    case 'SIGNER_UNCERTAIN': return 'Your signer may have signed this request, but no verified result was received. Nothing was published by this request.';
    case 'SIGNER_UNSUPPORTED': return 'Your signer does not support this request.';
    case 'LOCAL_KEY_UNAVAILABLE': return 'This account has no local key on this device.';
    case 'SIGNER_IDENTITY_CHANGED': return 'The installed signer app changed. Disconnect it and connect it again before signing.';
    case 'SIGNER_APP_FAILED': return 'The signer app closed or failed to return a result. Review a new request to try again.';
    default: return 'The signing change was not completed. Your saved account is unchanged.';
  }
}
