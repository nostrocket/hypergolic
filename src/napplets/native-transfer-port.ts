import { requireNativeModule } from 'expo';
import type { NativePublishedTransferPort } from './native-transfer.ts';

/** Loaded only by the trusted React Native owner, never by the isolated guest. */
export function loadNativePublishedTransferPort(): NativePublishedTransferPort {
  return requireNativeModule<NativePublishedTransferPort>('HypergolicNappletHost');
}
