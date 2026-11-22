import {encryptedEvent} from './encrypted-event.ts';
import {isAuthenticationEventKind} from './authentication-event.ts';

/** Apply only to ordinary publications. The shell handles encrypted protocols separately. */
export function deniedNappletPublication(kind: unknown, content: unknown): boolean {
  return isAuthenticationEventKind(kind) || encryptedEvent(kind, content);
}
