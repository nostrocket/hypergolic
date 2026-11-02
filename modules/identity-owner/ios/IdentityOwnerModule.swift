import ExpoModulesCore

public final class IdentityOwnerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HypergolicIdentityOwner")
    Function("claimIdentityOwner") { () -> Bool in
      guard IdentityOwnerClaim.claim() else { NativeIdentityOwnerContext.retire(); return false }
      // The actual main AppContext/runtime comes from native module construction, never JS input.
      guard let appContext, let runtime = try? appContext.runtime, runtime.isOnJavaScriptThread(),
        NativeIdentityOwnerContext.admit(appContext) else { NativeIdentityOwnerContext.retire(); return false }
      return true
    }
  }
}
