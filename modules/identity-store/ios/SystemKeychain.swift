import Foundation
import Security

/// Only nonsecret inventory and an AES wrapping key enter Keychain; never a Nostr secret payload.
public struct SystemKeychain: KeychainBackend {
  // Expo SecureStore's exact no-auth service suffix: preserve its receipt discovery address.
  public static let service = "org.nostrocket.hypergolic.identity.v1:no-auth"
  private let keychainService: String
  public init() { keychainService = Self.service }
  private init(service: String) { keychainService = service }
  /// Fixed native signer namespace. It is never selectable through an Expo argument.
  public static func nativeSignerStore() -> SystemKeychain {
    SystemKeychain(service: "org.nostrocket.hypergolic.native-signer.v1:no-auth")
  }
  private func query(_ item: KeychainItem) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: keychainService,
     kSecAttrAccount as String: Data(item.rawValue.utf8),
     kSecAttrGeneric as String: Data(item.rawValue.utf8),
     kSecAttrSynchronizable as String: false,
     kSecUseDataProtectionKeychain as String: true]
  }
  public func read(_ item: KeychainItem) throws -> Data? {
    var query = query(item)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw StoreFailure.unavailable }
    guard let data = result as? Data else { throw StoreFailure.corruptState }
    return data
  }
  public func hasLegacyStage() throws -> Bool {
    var query = query(.receipt)
    query[kSecAttrAccount as String] = Data("stage".utf8)
    query[kSecAttrGeneric as String] = Data("stage".utf8)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    // Presence only: do not retrieve a legacy Nostr-key payload or silently move/delete it.
    let status = SecItemCopyMatching(query as CFDictionary, nil)
    if status == errSecItemNotFound { return false }
    guard status == errSecSuccess else { throw StoreFailure.unavailable }
    return true
  }
  public func add(_ item: KeychainItem, value: Data) throws {
    var query = query(item)
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    query[kSecValueData as String] = value
    let status = SecItemAdd(query as CFDictionary, nil)
    if status == errSecDuplicateItem { throw StoreFailure.itemConflict }
    guard status == errSecSuccess else { throw StoreFailure.unavailable }
  }
  public func updateReceipt(_ value: Data) throws {
    let status = SecItemUpdate(query(.receipt) as CFDictionary, [kSecValueData as String: value] as CFDictionary)
    guard status == errSecSuccess else { throw StoreFailure.unavailable }
  }
}
