/** Compatibility for trusted dependencies that read Object.hasOwn during module initialization. */
function ensureObjectHasOwn(): void {
  if (typeof Object.hasOwn === 'function') return;
  Object.defineProperty(Object, 'hasOwn', { configurable: false, enumerable: false,
    value: (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key) });
}

// Run before dependency module initialization on WebViews lacking the static API.
ensureObjectHasOwn();
