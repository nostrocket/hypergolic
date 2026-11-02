import Foundation
#if canImport(HypergolicNappletHost)
import HypergolicNappletHost
#endif

/// Secret storage uses reference ownership; every ownership seam makes an explicit mutable copy.
final class NativeVaultSecret: @unchecked Sendable {
  private(set) var data: Data
  init(_ source: Data) { data = source.withUnsafeBytes { Data(bytes: $0.baseAddress!, count: $0.count) } }
  func copy() -> Data { data.withUnsafeBytes { Data(bytes: $0.baseAddress!, count: $0.count) } }
  func clear() { data.resetBytes(in: 0..<data.count); data.removeAll() }
  deinit { clear() }
}

enum NativeSigningMethod: String, Sendable { case local, nip46 }
struct NativeVaultRemoteMethod: Sendable {
  let peerPubkey: String
  let relays: [String]
  let transportSecret: NativeVaultSecret
  func clear() { transportSecret.clear() }
}

struct NativeVaultRecord: Sendable {
  struct Identity: Sendable {
    enum Origin: String, Sendable { case generated, imported, connected }
    let pubkey: String
    let addedAt: UInt64
    let origin: Origin
    var secret: NativeVaultSecret?
    var remote: NativeVaultRemoteMethod? = nil
    var selectedMethod: NativeSigningMethod? = .local
    func clear() { secret?.clear(); remote?.clear() }
  }
  let schema: Int
  let vaultId: String
  var revision: UInt64
  var selectedPubkey: String
  var identities: [Identity]
  static let maximumRevision: UInt64 = 9_007_199_254_740_991
  static let maximumBytes = 16_384 - 33

  static func isPubkey(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  static func isPoint(_ value: String) -> Bool {
    guard isPubkey(value) else { return false }
    let chars = Array(value.utf8)
    var bytes: [UInt8] = []
    func nibble(_ character: UInt8) -> UInt8 { character < 58 ? character - 48 : character - 87 }
    for index in stride(from: 0, to: 64, by: 2) { bytes.append(nibble(chars[index]) * 16 + nibble(chars[index + 1])) }
    return hypergolic_signer_public_key_valid(&bytes) == 1
  }
  static func isID(_ value: String) -> Bool {
    (16...80).contains(value.utf8.count) && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
  }
  mutating func clear() { for identity in identities { identity.clear() } }
  func validate() throws {
    guard (1...2).contains(schema), Self.isID(vaultId), revision > 0, revision <= Self.maximumRevision,
      (1...16).contains(identities.count), Self.isPubkey(selectedPubkey),
      identities.contains(where: { $0.pubkey == selectedPubkey }), Set(identities.map(\.pubkey)).count == identities.count else { throw NativeVaultFailure.corrupt }
    for identity in identities {
      guard Self.isPoint(identity.pubkey), identity.addedAt <= Self.maximumRevision else { throw NativeVaultFailure.corrupt }
      if let secret = identity.secret {
        let key = try NativeVaultKey(secret: secret.data); defer { key.destroy() }
        guard try key.publicKey() == identity.pubkey else { throw NativeVaultFailure.corrupt }
      }
      if let remote = identity.remote {
        guard Self.isPoint(remote.peerPubkey), (1...3).contains(remote.relays.count),
          Set(remote.relays).count == remote.relays.count else { throw NativeVaultFailure.corrupt }
        for relay in remote.relays { guard (try? NativeSignerRelayPolicy.normalized(relay)) == relay else { throw NativeVaultFailure.corrupt } }
        let key = try NativeVaultKey(secret: remote.transportSecret.data); defer { key.destroy() }
        _ = try key.publicKey()
      }
      switch identity.selectedMethod {
      case .local: guard identity.secret != nil else { throw NativeVaultFailure.corrupt }
      case .nip46: guard identity.remote != nil else { throw NativeVaultFailure.corrupt }
      case nil: break
      }
    }
  }
  func publicSnapshot() throws -> String {
    let publicIdentities: [[String: Any]] = identities.map { ["pubkey": $0.pubkey, "addedAt": $0.addedAt,
      "origin": $0.origin.rawValue, "status": "active"] }
    return try Self.json(["vaultId": vaultId, "revision": revision, "selectedPubkey": selectedPubkey,
      "identities": publicIdentities, "pendingDeletion": NSNull()])
  }
  func methodSnapshot(pubkey: String) throws -> String {
    guard let identity = identities.first(where: { $0.pubkey == pubkey }) else { throw NativeVaultFailure.notFound }
    var methods: [[String: Any]] = []
    if identity.secret != nil { methods.append(["kind": "local"]) }
    if let remote = identity.remote { methods.append(["kind": "nip46", "peerPubkey": remote.peerPubkey, "relays": remote.relays]) }
    return try Self.json(["vaultId": vaultId, "revision": revision, "pubkey": pubkey,
      "selectedMethod": identity.selectedMethod.map { $0.rawValue as Any } ?? NSNull(), "methods": methods])
  }
  private static func json(_ object: [String: Any]) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
  }
  func assertExpected(vaultID: String, revision expected: UInt64) throws {
    guard vaultId == vaultID, revision == expected else { throw NativeVaultFailure.stale }
  }
  mutating func advance() throws {
    guard revision < Self.maximumRevision else { throw NativeVaultFailure.corrupt }; revision += 1
  }
  // HGVR1 stores local scalars; HGVR2 adds explicit optional methods. Scalar bytes never enter JSON.
  static func decode(_ data: Data) throws -> NativeVaultRecord {
    var cursor = 0
    func take(_ count: Int) throws -> Data {
      guard count >= 0, cursor <= data.count - count else { throw NativeVaultFailure.corrupt }
      defer { cursor += count }; return data.subdata(in: cursor..<cursor + count)
    }
    func byte() throws -> UInt8 { try take(1).first! }
    func integer() throws -> UInt64 { try take(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } }
    func text(_ count: Int) throws -> String {
      guard let value = String(data: try take(count), encoding: .utf8) else { throw NativeVaultFailure.corrupt }; return value
    }
    func secret() throws -> NativeVaultSecret {
      var bytes = try take(32); defer { bytes.resetBytes(in: 0..<bytes.count) }; return NativeVaultSecret(bytes)
    }
    var identities: [Identity] = []; var allocated: [NativeVaultSecret] = []; var accepted = false
    defer { if !accepted { for secret in allocated { secret.clear() } } }
    guard data.count <= maximumBytes else { throw NativeVaultFailure.corrupt }
    let magic = try take(5), version: Int
    if magic == Data("HGVR1".utf8) { version = 1 } else if magic == Data("HGVR2".utf8) { version = 2 } else { throw NativeVaultFailure.corrupt }
    let length = Int(try byte()); guard (16...80).contains(length) else { throw NativeVaultFailure.corrupt }
    let vaultID = try text(length), revision = try integer(), selected = try text(64), count = try byte()
    guard (1...16).contains(Int(count)) else { throw NativeVaultFailure.corrupt }
    for _ in 0..<count {
      let pubkey = try text(64), addedAt = try integer(), originByte = try byte(), origin: Identity.Origin
      switch originByte { case 0: origin = .generated; case 1: origin = .imported; case 2 where version == 2: origin = .connected; default: throw NativeVaultFailure.corrupt }
      if version == 1 {
        let scalar = try secret(); allocated.append(scalar)
        identities.append(.init(pubkey: pubkey, addedAt: addedAt, origin: origin, secret: scalar)); continue
      }
      let selectedByte = try byte(), method: NativeSigningMethod?
      switch selectedByte { case 0: method = nil; case 1: method = .local; case 2: method = .nip46; default: throw NativeVaultFailure.corrupt }
      var local: NativeVaultSecret?, remote: NativeVaultRemoteMethod?
      switch try byte() { case 0: break; case 1: local = try secret(); allocated.append(local!); default: throw NativeVaultFailure.corrupt }
      switch try byte() {
      case 0: break
      case 1:
        let peer = try text(64), relayCount = try byte(); guard (1...3).contains(Int(relayCount)) else { throw NativeVaultFailure.corrupt }
        var relays: [String] = []
        for _ in 0..<relayCount {
          let size = Int(try byte()) * 256 + Int(try byte()); guard (1...2048).contains(size) else { throw NativeVaultFailure.corrupt }
          relays.append(try text(size))
        }
        let scalar = try secret(); allocated.append(scalar); remote = .init(peerPubkey: peer, relays: relays, transportSecret: scalar)
      default: throw NativeVaultFailure.corrupt
      }
      identities.append(.init(pubkey: pubkey, addedAt: addedAt, origin: origin, secret: local, remote: remote, selectedMethod: method))
    }
    guard cursor == data.count else { throw NativeVaultFailure.corrupt }
    let record = Self(schema: version, vaultId: vaultID, revision: revision, selectedPubkey: selected, identities: identities)
    try record.validate(); accepted = true; return record
  }
  func encoded() throws -> Data {
    try validate(); var output = Data("HGVR2".utf8); var accepted = false
    defer { if !accepted { output.resetBytes(in: 0..<output.count) } }
    func integer(_ value: UInt64) { for shift in stride(from: 56, through: 0, by: -8) { output.append(UInt8(truncatingIfNeeded: value >> shift)) } }
    output.append(UInt8(vaultId.utf8.count)); output.append(contentsOf: vaultId.utf8)
    integer(revision); output.append(contentsOf: selectedPubkey.utf8); output.append(UInt8(identities.count))
    for identity in identities {
      output.append(contentsOf: identity.pubkey.utf8); integer(identity.addedAt)
      output.append(identity.origin == .generated ? 0 : identity.origin == .imported ? 1 : 2)
      output.append(identity.selectedMethod == .local ? 1 : identity.selectedMethod == .nip46 ? 2 : 0)
      output.append(identity.secret == nil ? 0 : 1); if let secret = identity.secret { output.append(secret.data) }
      output.append(identity.remote == nil ? 0 : 1)
      if let remote = identity.remote {
        output.append(contentsOf: remote.peerPubkey.utf8); output.append(UInt8(remote.relays.count))
        for relay in remote.relays { let count = relay.utf8.count; output.append(UInt8(count >> 8)); output.append(UInt8(count & 255)); output.append(contentsOf: relay.utf8) }
        output.append(remote.transportSecret.data)
      }
    }
    guard output.count <= Self.maximumBytes else { throw NativeVaultFailure.signerUnsupported }; accepted = true; return output
  }
}
