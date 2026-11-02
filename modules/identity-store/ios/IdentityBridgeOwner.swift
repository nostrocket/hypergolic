import Foundation
import Synchronization

/// Implemented by the trusted native authentication/action owner, never by a WebView or JS callback.
/// Atomically consume exactly this one-use token for deletion of targetPubkey. Check action, expiry,
/// identity epoch, selected usable replacement, settings session, cancellation and real background.
/// A transient inactive state caused by an OS prompt is not itself a background transition.
public protocol NativeIdentityGrantOwner: AnyObject, Sendable {
  func consumeDeletionGrant(token: String, targetPubkey: String) throws
}

/// Native-only installation once per process. No exported Expo method can install or replace a provider.
public final class NativeIdentityDeletionAuthority: DeletionAuthorization, Sendable {
  public static let shared = NativeIdentityDeletionAuthority()
  private let provider = Mutex<(any NativeIdentityGrantOwner)?>(nil)
  init() {}

  public func install(_ owner: any NativeIdentityGrantOwner) throws {
    try provider.withLock { provider in
      guard provider == nil else { throw StoreFailure.itemConflict }
      provider = owner
    }
  }
  public func consumeDeletion(pubkey: String, token: String) throws {
    guard Receipt.isPubkey(pubkey), BridgeBounds.isToken(token) else { throw StoreFailure.unauthorized }
    guard let owner = provider.withLock({ $0 }) else { throw StoreFailure.unauthorized }
    do { try owner.consumeDeletionGrant(token: token, targetPubkey: pubkey) }
    catch { throw StoreFailure.unauthorized }
  }
}

enum BridgeBounds {
  static func payload(_ value: String) throws {
    guard !value.isEmpty, value.utf8.count <= 2048,
      value.utf8.allSatisfy({ (32...126).contains($0) }) else { throw StoreFailure.invalidInput }
  }
  static func pubkey(_ value: String) throws {
    guard Receipt.isPubkey(value) else { throw StoreFailure.invalidInput }
  }
  static func isToken(_ value: String) -> Bool {
    value.utf8.count >= 16 && value.utf8.count <= 128 && value.utf8.allSatisfy {
      (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
    }
  }
}

/// The global production instance is shared by every Expo module/runtime in this process.
/// All key/file effects remain serialized by one IdentityFileStore actor. The cap includes calls
/// waiting on that actor; no caller can choose a Keychain service, file path, wrapping key or nonce.
protocol IdentityStoreBackend: Actor {
  func getItem(_ key: String) async throws -> String?
  func setItem(_ key: String, value: String) async throws
  func deleteItem(_ key: String, deletionToken: String?) async throws
}

actor IdentityBridgeOwner {
  typealias Factory = @Sendable () throws -> any IdentityStoreBackend
  private let factory: Factory
  private var store: (any IdentityStoreBackend)?
  private var pending = 0
  private let maximumPending = 32
  init(factory: @escaping Factory) { self.factory = factory }

  private func withStore<T: Sendable>(_ operation: @Sendable (any IdentityStoreBackend) async throws -> T) async throws -> T {
    guard pending < maximumPending else { throw StoreFailure.unavailable }
    pending += 1
    defer { pending -= 1 }
    do {
      if store == nil { store = try factory() }
      guard let store else { throw StoreFailure.unavailable }
      return try await operation(store)
    } catch { throw error as? StoreFailure ?? .unavailable }
  }
  func readInventory() async throws -> String? { try await withStore { try await $0.getItem("inventory") } }
  func writeInventory(_ value: String) async throws {
    try BridgeBounds.payload(value)
    _ = try Receipt(value)
    try await withStore { try await $0.setItem("inventory", value: value) }
  }
  func readStage() async throws -> String? { try await withStore { try await $0.getItem("stage") } }
  func writeStage(_ value: String) async throws {
    try BridgeBounds.payload(value)
    try await withStore { try await $0.setItem("stage", value: value) }
  }
  func deleteStage() async throws { try await withStore { try await $0.deleteItem("stage", deletionToken: nil) } }
  func readSecret(_ pubkey: String) async throws -> String? {
    try BridgeBounds.pubkey(pubkey)
    return try await withStore { try await $0.getItem("secret.\(pubkey)") }
  }
  func writeSecret(_ pubkey: String, value: String) async throws {
    try BridgeBounds.pubkey(pubkey); try BridgeBounds.payload(value)
    try await withStore { try await $0.setItem("secret.\(pubkey)", value: value) }
  }
  func deleteSecret(_ pubkey: String, token: String) async throws {
    try BridgeBounds.pubkey(pubkey)
    guard BridgeBounds.isToken(token) else { throw StoreFailure.unauthorized }
    try await withStore { try await $0.deleteItem("secret.\(pubkey)", deletionToken: token) }
  }
}

enum IdentityStoreProcess {
  static let owner = IdentityBridgeOwner {
    #if os(iOS)
    return try NativeIdentityAuthorizationServices.shared().store
    #else
    throw StoreFailure.unavailable
    #endif
  }
}

extension StoreFailure {
  var bridgeCode: String {
    switch self {
    case .unavailable: "ERR_IDENTITY_STORE_UNAVAILABLE"
    case .corruptState: "ERR_IDENTITY_STORE_CORRUPT"
    case .recoveryRequired: "ERR_IDENTITY_STORE_RECOVERY_REQUIRED"
    case .invalidInput: "ERR_IDENTITY_STORE_INVALID_INPUT"
    case .itemConflict: "ERR_IDENTITY_STORE_CONFLICT"
    case .unauthorized: "ERR_IDENTITY_STORE_UNAUTHORIZED"
    }
  }
  var safeDescription: String {
    switch self {
    case .unavailable: "Identity storage is unavailable."
    case .corruptState: "Identity storage could not be validated."
    case .recoveryRequired: "Identity storage requires recovery."
    case .invalidInput: "Invalid identity storage request."
    case .itemConflict: "Identity storage conflicts with existing data."
    case .unauthorized: "Identity deletion is not authorized."
    }
  }
}
