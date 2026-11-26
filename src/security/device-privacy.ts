import { requireNativeModule } from 'expo';

export type DevicePrivacyPreferences = { workspace: boolean; local: boolean; external: boolean };
type DevicePrivacyModule = {
  prepare(): Promise<boolean>;
  preferences(pubkey: string): Promise<DevicePrivacyPreferences>;
  configure(mode: keyof DevicePrivacyPreferences, pubkey: string, value: boolean): Promise<boolean>;
  lock(): Promise<void>;
};
export function devicePrivacy() { return requireNativeModule<DevicePrivacyModule>('HypergolicDevicePrivacy'); }
