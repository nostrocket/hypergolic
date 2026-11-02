import * as SecureStore from 'expo-secure-store';
import {CryptoDigestAlgorithm, digestStringAsync} from 'expo-crypto';
import {openConfigStore} from './config-store';
/** Native Android Keystore/iOS Keychain records with a dedicated service and scope hash. */
export function openNativeConfigStore() {
  return openConfigStore(SecureStore, text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text), SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY);
}
