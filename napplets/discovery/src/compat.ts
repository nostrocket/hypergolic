// Older Android WebViews can lack this API in the guest's own realm.
// Noble uses it while initializing the signature verifier.
if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true, writable: true,
    value: (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key),
  });
}
