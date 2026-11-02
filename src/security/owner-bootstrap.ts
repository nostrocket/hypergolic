export class IdentityRestartRequired extends Error {
  readonly code = 'IDENTITY_RESTART_REQUIRED';
  constructor() {
    super('Restart the app to continue.');
    this.name = 'IdentityRestartRequired';
  }
}

/** Create once, at the trusted module composition root. No reset or retry closure. */
export function createOwnerBootstrap<T>(claim: () => boolean, initialize: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending) return pending;
    let admitted = false;
    try { admitted = claim() === true; } catch { /* Uncertain claim never admits persistence. */ }
    // Install the private Promise before an initializer can reenter.
    // The native claim itself is synchronous and precedes initialization.
    pending = admitted ? Promise.resolve().then(initialize) : Promise.reject(new IdentityRestartRequired());
    return pending;
  };
}
