import { DISCOVERY_BUNDLE } from '../runtime/discovery-bundle.ts';
import type { NappletDescriptor, Workspace } from './workspace.ts';

export const MAX_PINS = 64;
export function defaultPins(): readonly NappletDescriptor[] {
  return [{id: 'napplet-discovery-1', title: 'Discover', publisher: 'bundled-unsigned-fixture',
    appId: 'napplet-discovery', version: DISCOVERY_BUNDLE.aggregateHash, source: 'bundled'}];
}
export const homeVisible = (state: Workspace): boolean => state.home ?? state.sessions.length === 0;
export const pinnedNapplets = (state: Workspace): readonly NappletDescriptor[] => state.pins ?? defaultPins();
export const pinKey = (item: NappletDescriptor): string => JSON.stringify([item.source, item.publisher, item.appId]);
export const isPinned = (state: Workspace, item: NappletDescriptor): boolean => pinnedNapplets(state).some(pin => pinKey(pin) === pinKey(item));
export function pinNapplet(state: Workspace, item: NappletDescriptor): Workspace {
  const pins = pinnedNapplets(state);
  if (isPinned(state, item)) return state;
  if (pins.length >= MAX_PINS) throw new Error('Your Home is full. Unpin a napplet first.');
  return {...state, pins: [...pins, {...item}]};
}
export function unpinNapplet(state: Workspace, item: NappletDescriptor): Workspace {
  return {...state, pins: pinnedNapplets(state).filter(pin => pinKey(pin) !== pinKey(item))};
}
export function showHome(state: Workspace): Workspace { return {...state, overview: true, home: true}; }
