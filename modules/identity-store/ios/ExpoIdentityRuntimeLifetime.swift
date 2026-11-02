import ExpoModulesCore
import ExpoModulesJSI

/// Synchronous trusted activation, after the process claim accepts this exact main AppContext.
/// Never use a subordinate worklet runtime or decide replacement order from late Module.OnCreate.
@JavaScriptActor func attachIdentityLifetime(_ lease: NativeIdentityRuntimeLease, to appContext: AppContext) throws {
  do {
    let runtime = try appContext.runtime
    let lifetime = IdentityRuntimeLifetime(lease: lease)
    runtime.longLivedObjects.add(lifetime)
    do { try lease.didBindMainRuntime() }
    catch { runtime.longLivedObjects.remove(lifetime); throw error }
  } catch { lease.dispose(); throw DeletionActionFailure.unavailable }
}

@JavaScriptActor private final class IdentityRuntimeLifetime: LongLivedObject {
  private let lease: NativeIdentityRuntimeLease
  init(lease: NativeIdentityRuntimeLease) { self.lease = lease }
  func allowRelease() { lease.dispose() }
}
