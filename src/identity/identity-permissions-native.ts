import {requireNativeModule} from 'expo';
import type {IdentityListNativePolicy, IdentityListOwner} from './identity-permissions';
interface Module {replaceIdentityListAccess(raw: string): void}
export function loadIdentityListNativePolicy(): IdentityListNativePolicy {
  const native = requireNativeModule<Module>('HypergolicNappletHost');
  return Object.freeze({replace(owners: readonly IdentityListOwner[]) {native.replaceIdentityListAccess(JSON.stringify(owners));}});
}
