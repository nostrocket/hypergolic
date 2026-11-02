import type { IdentityTransition } from '../security/identity-transition.ts';
import { ShellStorageError, type RequestOptions, type TrustedUser } from '../storage/ports.ts';
import type { RoutingBroker } from './routing-broker.ts';
import type { CatalogHandler, CatalogSnapshot, RoutingCatalog } from './routing-catalog.ts';
import type { RoutingNativePort } from './routing-port.ts';
export interface RoutingSettingsService {
  list(options?: RequestOptions): Promise<CatalogSnapshot>;
  prefer(role: string, handler: CatalogHandler | null, options?: RequestOptions): Promise<CatalogSnapshot>;
  remove(handler: CatalogHandler, options?: RequestOptions): Promise<CatalogSnapshot>;
}
/** App-only controls capture the current identity and native foreground revision per action. */
export function createRoutingSettings(identity: Pick<IdentityTransition, 'sessionAuthority'>, native: RoutingNativePort,
  catalog: RoutingCatalog, broker: Pick<RoutingBroker, 'catalogChanged'>): RoutingSettingsService {
  function capture(options?: RequestOptions): TrustedUser {
    const authority = identity.sessionAuthority(), state = native.state();
    const owner = Object.freeze({user: authority.user, assertActive() {
      authority.assertActive(); const current = native.state();
      if (options?.signal?.aborted || !current.available || !current.foreground || current.user !== authority.user || current.epoch !== authority.epoch || current.revision !== state.revision) throw new ShellStorageError('REVOKED');
    }});
    owner.assertActive(); return owner;
  }
  async function changed(owner: TrustedUser, roles: readonly string[], options?: RequestOptions) {
    owner.assertActive(); await broker.catalogChanged(owner, roles); owner.assertActive();
    return catalog.list(owner, options);
  }
  return Object.freeze({
    async list(options?: RequestOptions) {return catalog.list(capture(options), options);},
    async prefer(role: string, handler: CatalogHandler | null, options?: RequestOptions) {
      const owner = capture(options); await catalog.prefer(owner, role, handler, options);
      return changed(owner, [role], options);
    },
    async remove(handler: CatalogHandler, options?: RequestOptions) {
      const owner = capture(options); await catalog.remove(owner, handler, options);
      return changed(owner, handler.roles.map(role => role.archetype), options);
    },
  });
}
