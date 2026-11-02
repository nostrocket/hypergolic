import Synchronization

/// Native-only companion to the one-shot process claim. Never resets or reclaims that claim.
public final class IdentityOwnerContextRegistry<Context: AnyObject & Sendable>: Sendable {
  private struct State: Sendable {
    weak var context: Context?
    var admitted = false
    var retired = false
    var revoke: (@Sendable () -> Void)?
  }
  private let state = Mutex(State())
  public init() {}
  public func admit(_ context: Context) -> Bool {
    state.withLock { value in
      guard !value.admitted, !value.retired else { return false }
      value.admitted = true; value.context = context
      return true
    }
  }
  public func owns(_ context: Context) -> Bool {
    state.withLock { $0.admitted && !$0.retired && $0.context === context }
  }
  /// Callback is native-owned, synchronous and must not reenter this registry.
  public func registerRevocation(_ context: Context, revoke: @escaping @Sendable () -> Void) -> Bool {
    state.withLock { value in
      guard value.admitted, !value.retired, value.context === context, value.revoke == nil else { return false }
      value.revoke = revoke
      return true
    }
  }
  public func retire() {
    state.withLock { value in
      guard !value.retired else { return }
      // Revoke synchronously before retirement is observable. Callback never reads this registry.
      value.revoke?()
      value.revoke = nil; value.context = nil; value.retired = true
    }
  }
}
