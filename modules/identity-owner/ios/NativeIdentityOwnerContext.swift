import ExpoModulesCore

/// Only the synchronous native claim module may admit its actual AppContext.
public enum NativeIdentityOwnerContext {
  private static let registry = IdentityOwnerContextRegistry<AppContext>()
  static func admit(_ context: AppContext) -> Bool { registry.admit(context) }
  static func retire() { registry.retire() }
  public static func owns(_ context: AppContext) -> Bool { registry.owns(context) }
  public static func registerRevocation(_ context: AppContext, revoke: @escaping @Sendable () -> Void) -> Bool {
    registry.registerRevocation(context, revoke: revoke)
  }
}
