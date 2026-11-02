/** Kehto's native operation override uses Object.hasOwn, absent from older WebViews. */
export function ensureObjectHasOwn(): void {
  if (typeof Object.hasOwn === 'function') return;
  Object.defineProperty(Object, 'hasOwn', { configurable: false, enumerable: false,
    value: (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key) });
}

// Run before dependency module initialization on WebViews lacking the static API.
ensureObjectHasOwn();
