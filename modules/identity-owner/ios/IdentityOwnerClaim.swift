import Synchronization

/// One trusted identity bootstrap per OS process. Deliberately no reset or reclaim.
enum IdentityOwnerClaim {
  private static let consumed = Mutex(false)

  static func claim() -> Bool {
    consumed.withLock { value in
      guard !value else { return false }
      value = true
      return true
    }
  }
}
