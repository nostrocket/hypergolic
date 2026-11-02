/** Known unsupported native environment; never inferred from a storage read/write failure. */
export class IdentityDeviceRequired extends Error {
  readonly code = 'IDENTITY_DEVICE_REQUIRED';
  constructor() {
    super('Use a physical iPhone to continue.');
    this.name = 'IdentityDeviceRequired';
  }
}
