import type {IdentityTransition} from '../security/identity-transition.ts';
import type {RoutingNativePort} from '../routing/routing-port.ts';
import {ShellStorageError, type RequestOptions, type TrustedUser} from '../storage/ports.ts';
import type {NotifyBroker} from './notify-broker.ts';
import type {NotifyPermission} from './notify-permissions.ts';
export interface NotificationSettingsService {
  list(options?: RequestOptions): Promise<readonly NotifyPermission[]>;
  revoke(permission: NotifyPermission, options?: RequestOptions): Promise<readonly NotifyPermission[]>;
}
/** Every native Settings action captures identity, epoch, foreground revision and cancellation. */
export function createNotificationSettings(identity: Pick<IdentityTransition, 'sessionAuthority'>, native: RoutingNativePort,
  broker: Pick<NotifyBroker, 'listPermissions' | 'revoke'>): NotificationSettingsService {
  function capture(options?: RequestOptions): TrustedUser {
    const authority = identity.sessionAuthority(), state = native.state();
    const owner = Object.freeze({user: authority.user, assertActive() {
      authority.assertActive(); const current = native.state();
      if (options?.signal?.aborted || !current.available || !current.foreground || current.user !== authority.user || current.epoch !== authority.epoch || current.revision !== state.revision) throw new ShellStorageError('REVOKED');
    }});
    owner.assertActive(); return owner;
  }
  return Object.freeze({
    async list(options?: RequestOptions) {return broker.listPermissions(capture(options));},
    async revoke(permission: NotifyPermission, options?: RequestOptions) {
      const owner = capture(options), saved = await broker.listPermissions(owner); owner.assertActive();
      const row = saved.find(value => value.publisher === permission.publisher && value.appId === permission.appId && value.channel === permission.channel);
      if (!row) throw new ShellStorageError('REVOKED');
      await broker.revoke(Object.freeze({...owner, publisher: row.publisher, appId: row.appId}), row.channel); owner.assertActive();
      return broker.listPermissions(owner);
    },
  });
}
