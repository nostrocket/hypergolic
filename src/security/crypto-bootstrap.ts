import { getRandomValues } from 'expo-crypto';
import { installNativeRandom } from './native-random';

// Avoid getRandomBytes: its development fallback uses Math.random.
export function initializeNativeRandom(): void {
  installNativeRandom(globalThis, getRandomValues);
}
