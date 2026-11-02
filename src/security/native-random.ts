type IntegerArray = Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | BigInt64Array | BigUint64Array;
export type RandomValues = <T extends IntegerArray>(array: T) => T;
export interface RandomGlobal { crypto?: object }
type NativeFill = (bytes: Uint8Array) => unknown;
const installed = new WeakMap<RandomGlobal, { crypto: object; fill: NativeFill; random: RandomValues }>();

export class EntropyUnavailableError extends Error {
  constructor() { super('Secure random source is unavailable'); this.name = 'EntropyUnavailableError'; }
}

/** Install before importing Nostr code. The supplied port must be native getRandomValues. */
export function installNativeRandom(target: RandomGlobal, fill: NativeFill): RandomValues {
  if (typeof fill !== 'function') throw new EntropyUnavailableError();
  const prior = installed.get(target);
  if (prior) {
    if (prior.fill !== fill || target.crypto !== prior.crypto
      || Object.getOwnPropertyDescriptor(prior.crypto, 'getRandomValues')?.value !== prior.random) throw new EntropyUnavailableError();
    return prior.random;
  }
  const getRandomValues: RandomValues = array => {
    if (!(array instanceof Int8Array || array instanceof Uint8Array || array instanceof Uint8ClampedArray
      || array instanceof Int16Array || array instanceof Uint16Array || array instanceof Int32Array
      || array instanceof Uint32Array || array instanceof BigInt64Array || array instanceof BigUint64Array)) {
      throw new TypeError('Random values require an integer typed array');
    }
    if (array.byteLength > 65_536) throw new RangeError('Random request exceeds 65536 bytes');
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    try { fill(bytes); }
    catch { bytes.fill(0); throw new EntropyUnavailableError(); }
    return array;
  };
  try {
    const crypto = target.crypto ?? {};
    if (typeof crypto !== 'object' || crypto === null) throw new EntropyUnavailableError();
    Object.defineProperty(crypto, 'getRandomValues', { value: getRandomValues, enumerable: true, configurable: false, writable: false });
    Object.defineProperty(target, 'crypto', { value: crypto, configurable: false, writable: false });
    const probe = new Uint8Array(32);
    try { getRandomValues(probe); } finally { probe.fill(0); }
    installed.set(target, { crypto, fill, random: getRandomValues });
    return getRandomValues;
  } catch { throw new EntropyUnavailableError(); }
}
