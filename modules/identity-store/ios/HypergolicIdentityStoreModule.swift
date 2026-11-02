import ExpoModulesCore

/// The historical secret-bearing Expo surface is retired. Production uses NativeVault metadata only.
public final class HypergolicIdentityStoreModule: Module {
  public func definition() -> ModuleDefinition { Name("HypergolicIdentityStore") }
}
