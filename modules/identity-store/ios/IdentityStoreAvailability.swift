/// Environment support only: no filesystem, Keychain, authentication or identity access.
/// A supported device must still pass the actual storage protection checks on every operation.
enum IdentityStoreAvailability {
  static var isSupportedEnvironment: Bool {
    #if os(iOS) && !targetEnvironment(simulator)
    true
    #else
    false
    #endif
  }
}
