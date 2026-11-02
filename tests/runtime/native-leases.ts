import type { NativeCapabilityPort } from '../../src/runtime/capability-broker.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';

/** Test-only lease adapter. Native origin, frame, expiry and module behavior need device proof. */
export class NativeLeases implements NativeCapabilityPort {
  private entries = new Map<string, { raw: string; active: boolean; claimed: boolean }>();
  readonly results = new Map<string, unknown>();
  private instances = 0;
  newInstanceId(): string { return '00000000-0000-4000-8000-' + String(++this.instances).padStart(12, '0'); }
  finishCalls = 0;
  onFinish: ((token: string) => void) | null = null;
  add(config: NativeRegistration, request: unknown): string {
    const token = 'native-token-' + this.entries.size;
    this.entries.set(token, { raw: JSON.stringify({ registration: config, request: JSON.stringify(request) }), active: true, claimed: false });
    return token;
  }
  take(token: string): string | null {
    const entry = this.entries.get(token);
    if (!entry || !entry.active || entry.claimed) return null;
    entry.claimed = true; return entry.raw;
  }
  isActive(token: string): boolean { return this.entries.get(token)?.active ?? false; }
  revoke(token: string): void { const entry = this.entries.get(token); if (entry) entry.active = false; }
  finish(token: string, response: string | null): void {
    this.finishCalls++;
    this.results.set(token, this.isActive(token) && response !== null ? JSON.parse(response) : null);
    this.revoke(token);
    this.onFinish?.(token);
  }
}
