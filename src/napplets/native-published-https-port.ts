import { requireNativeModule } from 'expo';
import { createNativePublishedHttpsFetch, type NativePublishedHttpsPort } from './native-published-https.ts';
import type { PublishedHttpsFetch } from './published-source.ts';

export function loadNativePublishedHttpsFetch(): PublishedHttpsFetch {
  return createNativePublishedHttpsFetch(requireNativeModule<NativePublishedHttpsPort>('HypergolicNappletHost'));
}
