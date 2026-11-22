import {isAuthenticationEventKind} from './authentication-event.ts';

/** Apply only to ordinary publications. The shell handles encrypted protocols separately. */
export function deniedNappletPublication(kind: unknown, content: unknown): boolean {
  if (isAuthenticationEventKind(kind) || kind === 4 || kind === 13 || kind === 1059) return true;
  if (typeof content !== 'string') return true;
  // NIP-04 places the base64 initialization vector after the encrypted body.
  if (/^[A-Za-z0-9+/]+={0,2}\?iv=[A-Za-z0-9+/]{22}==$/.test(content)) return true;
  // NIP-44 v2 starts with byte 2 and contains at least 99 bytes before encoding.
  return content.length >= 132 && content.length % 4 === 0 &&
    /^A[g-v][A-Za-z0-9+/]*={0,2}$/.test(content);
}
