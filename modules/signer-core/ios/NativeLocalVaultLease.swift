import Foundation
import Synchronization

/// Native composition only. Immutable metadata, without key material or signing authority.
public final class NativeLocalVaultLease: @unchecked Sendable {
  public let account: String, vaultId: String
  public let vaultRevision: UInt64, runtimeEpoch: UInt64
  private let current: @Sendable () -> Bool
  private let stopped = Mutex(false)
  init(account: String, vaultId: String, revision: UInt64, epoch: UInt64, current: @escaping @Sendable () -> Bool) {
    self.account=account; self.vaultId=vaultId; vaultRevision=revision; runtimeEpoch=epoch; self.current=current
  }
  /// The actor retires the brand before every record mutation attempt; runtime checks are synchronous.
  public var isCurrent: Bool {
    guard !stopped.withLock({ $0 }) else { return false }
    guard current(), !stopped.withLock({ $0 }) else { retire(); return false }
    return true
  }
  func retire() { stopped.withLock { $0=true } }
  private struct Provider: @unchecked Sendable {
    weak var owner: AnyObject?
    let capture: @Sendable () async throws -> NativeLocalVaultLease
  }
  private static let provider = Mutex<Provider?>(nil)
  static func install(owner: AnyObject, capture: @escaping @Sendable () async throws -> NativeLocalVaultLease) throws {
    try provider.withLock { value in
      guard value?.owner == nil || value?.owner === owner else { throw Unavailable() }
      value=Provider(owner:owner,capture:capture)
    }
  }
  public struct Unavailable: Error {}
  /// No Expo function exports this entry point; fields come from the installed native vault owner.
  public static func capture() async throws -> NativeLocalVaultLease {
    guard let value=provider.withLock({ $0 }), value.owner != nil else { throw Unavailable() }
    let lease=try await value.capture()
    guard lease.isCurrent else { throw Unavailable() }; return lease
  }
}
