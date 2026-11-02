import Foundation
import CryptoKit
#if canImport(HypergolicIdentityStore)
import HypergolicIdentityStore
#endif
#if canImport(HypergolicNappletHost)
import HypergolicNappletHost
#endif

/// One process-native coordinator; actors never cache plaintext records between operations.
actor NativeVaultCore {
  static let shared = NativeVaultCore()
  private var storage: NativeSignerVaultStorage?
  private var busy = false
  private let testingExchange: NativeNip46Client.Exchange?
  init() { testingExchange = nil }
  init(testingStorage: NativeSignerVaultStorage, testingExchange: NativeNip46Client.Exchange? = nil) {
    storage = testingStorage
    self.testingExchange = testingExchange
  }
  private func store() throws -> NativeSignerVaultStorage {
    if let storage { return storage }
    let created = try NativeSignerVaultStorage.applicationStore(); storage = created; return created
  }
  private func begin() throws { guard !busy else { throw NativeVaultFailure.busy }; busy = true }
  private func readRecord(_ store: NativeSignerVaultStorage) async throws -> (NativeVaultRecord, Data) {
    guard var loaded = try await store.read() else { throw NativeVaultFailure.recovery }
    defer { loaded.plaintext.resetBytes(in: 0..<loaded.plaintext.count) }
    var record = try NativeVaultRecord.decode(loaded.plaintext)
    guard record.vaultId == loaded.vaultID else { record.clear(); throw NativeVaultFailure.corrupt }
    return (record, Data(SHA256.hash(data: loaded.plaintext)))
  }
  private func persist(_ record: NativeVaultRecord, digest: Data, store: NativeSignerVaultStorage, authority: any NativeSignerStorageAuthority) async throws {
    var payload = try record.encoded(); defer { payload.resetBytes(in: 0..<payload.count) }
    try await store.replace(vaultID: record.vaultId, expectedPlaintextDigest: digest, plaintext: payload, authority: authority)
  }
  func open(authority: any NativeSignerStorageAuthority, current: @Sendable () -> Bool) async throws -> String {
    try begin(); defer { busy = false }
    guard current() else { throw NativeVaultFailure.stale }
    let store = try store()
    if var loaded = try await store.read() {
      defer { loaded.plaintext.resetBytes(in: 0..<loaded.plaintext.count) }
      var record = try NativeVaultRecord.decode(loaded.plaintext); defer { record.clear() }
      guard record.vaultId == loaded.vaultID else { throw NativeVaultFailure.corrupt }
      guard current() else { throw NativeVaultFailure.stale }
      return try record.publicSnapshot()
    }
    guard current() else { throw NativeVaultFailure.stale }
    let key = try NativeVaultKey(); defer { key.destroy() }
    let pubkey = try key.publicKey(), vaultID = UUID().uuidString.lowercased()
    let now = Date().timeIntervalSince1970 * 1000
    guard now >= 0, now <= Double(NativeVaultRecord.maximumRevision) else { throw NativeVaultFailure.storage }
    var payload = try key.withPersistenceSecret { secret in
      var record = NativeVaultRecord(schema: 2, vaultId: vaultID, revision: 1, selectedPubkey: pubkey,
        identities: [.init(pubkey: pubkey, addedAt: UInt64(now), origin: .generated, secret: NativeVaultSecret(secret))])
      defer { record.clear() }; return try record.encoded()
    }
    defer { payload.resetBytes(in: 0..<payload.count) }
    guard current() else { throw NativeVaultFailure.stale }
    try await store.initialize(vaultID: vaultID, plaintext: payload, authority: authority)
    var (record, _) = try await readRecord(store); defer { record.clear() }
    guard current() else { throw NativeVaultFailure.readback }
    return try record.publicSnapshot()
  }
  func snapshot(vaultID: String, revision: UInt64, current: @Sendable () -> Bool) async throws -> String {
    try begin(); defer { busy = false }
    var (record, _) = try await readRecord(try store()); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current() else { throw NativeVaultFailure.stale }; return try record.publicSnapshot()
  }
  func selected(vaultID: String, revision: UInt64, current: @Sendable () -> Bool) async throws -> String {
    try begin(); defer { busy = false }
    var (record, _) = try await readRecord(try store()); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current() else { throw NativeVaultFailure.stale }; return record.selectedPubkey
  }
  func commitImport(key: NativeVaultKey, vaultID: String, revision: UInt64, authority: any NativeSignerStorageAuthority, current: @Sendable () -> Bool, revokePending: @Sendable () -> Void = {}) async throws -> String {
    try begin(); defer { busy = false }
    let store = try store()
    var (record, digest) = try await readRecord(store); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current() else { throw NativeVaultFailure.stale }
    let pubkey = try key.publicKey()
    var persisted = false
    if let index = record.identities.firstIndex(where: { $0.pubkey == pubkey }) {
      if record.identities[index].secret == nil {
        try key.withPersistenceSecret { record.identities[index].secret = NativeVaultSecret($0) }
      }
      if record.selectedPubkey != pubkey || record.identities[index].selectedMethod != .local {
        record.selectedPubkey = pubkey; record.identities[index].selectedMethod = .local
        try record.advance(); guard current() else { throw NativeVaultFailure.stale }; revokePending(); try await persist(record, digest: digest, store: store, authority: authority); persisted = true
      }
    } else {
      guard record.identities.count < 16 else { throw NativeVaultFailure.limitReached }
      let now = Date().timeIntervalSince1970 * 1000
      guard now >= 0, now <= Double(NativeVaultRecord.maximumRevision) else { throw NativeVaultFailure.storage }
      try key.withPersistenceSecret { secret in
        record.identities.append(.init(pubkey: pubkey, addedAt: UInt64(now), origin: .imported, secret: NativeVaultSecret(secret)))
      }
      record.selectedPubkey = pubkey; try record.advance()
      guard current() else { throw NativeVaultFailure.stale }
      revokePending(); try await persist(record, digest: digest, store: store, authority: authority); persisted = true
    }
    var (committed, _) = try await readRecord(store); defer { committed.clear() }
    guard current() else { throw persisted ? NativeVaultFailure.readback : .stale }
    guard committed.revision == record.revision, committed.selectedPubkey == pubkey else { throw NativeVaultFailure.readback }
    return try committed.publicSnapshot()
  }
  func select(pubkey: String, vaultID: String, revision: UInt64, authority: any NativeSignerStorageAuthority, current: @Sendable () -> Bool, revokePending: @Sendable () -> Void = {}) async throws -> String {
    try begin(); defer { busy = false }
    let store = try store(); var (record, digest) = try await readRecord(store); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current() else { throw NativeVaultFailure.stale }
    guard record.identities.contains(where: { $0.pubkey == pubkey }) else { throw NativeVaultFailure.notFound }
    var persisted = false
    if record.selectedPubkey != pubkey {
      record.selectedPubkey = pubkey; try record.advance(); guard current() else { throw NativeVaultFailure.stale }; revokePending(); try await persist(record, digest: digest, store: store, authority: authority); persisted = true
    }
    var (committed, _) = try await readRecord(store); defer { committed.clear() }
    guard current() else { throw persisted ? NativeVaultFailure.readback : .stale }
    guard committed.revision == record.revision else { throw NativeVaultFailure.readback }
    return try committed.publicSnapshot()
  }
  private func finishMethodMutation(_ record: NativeVaultRecord, digest: Data, store: NativeSignerVaultStorage,
    authority: any NativeSignerStorageAuthority, current: @Sendable () -> Bool,
    revokePending: @Sendable () -> Void) async throws -> String {
    guard current() else { throw NativeVaultFailure.stale }
    revokePending()
    try await persist(record, digest: digest, store: store, authority: authority)
    var (committed, _) = try await readRecord(store); defer { committed.clear() }
    guard current(), committed.revision == record.revision, committed.selectedPubkey == record.selectedPubkey else { throw NativeVaultFailure.readback }
    return try committed.publicSnapshot()
  }
  func selectMethod(pubkey: String, method: NativeSigningMethod, vaultID: String, revision: UInt64,
    authority: any NativeSignerStorageAuthority, current: @Sendable () -> Bool,
    revokePending: @Sendable () -> Void) async throws -> String {
    try begin(); defer { busy = false }
    let store = try store(); var (record, digest) = try await readRecord(store); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current(), record.selectedPubkey == pubkey else { throw NativeVaultFailure.stale }
    guard let index = record.identities.firstIndex(where: { $0.pubkey == pubkey }) else { throw NativeVaultFailure.notFound }
    switch method {
    case .local: guard record.identities[index].secret != nil else { throw NativeVaultFailure.localKeyUnavailable }
    case .nip46: guard record.identities[index].remote != nil else { throw NativeVaultFailure.signerUnavailable }
    }
    guard record.identities[index].selectedMethod != method else { return try record.publicSnapshot() }
    record.identities[index].selectedMethod = method; try record.advance()
    return try await finishMethodMutation(record, digest: digest, store: store, authority: authority, current: current, revokePending: revokePending)
  }
  func disconnectRemote(pubkey: String, vaultID: String, revision: UInt64,
    authority: any NativeSignerStorageAuthority, current: @Sendable () -> Bool,
    revokePending: @Sendable () -> Void) async throws -> String {
    try begin(); defer { busy = false }
    let store = try store(); var (record, digest) = try await readRecord(store); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current(), record.selectedPubkey == pubkey else { throw NativeVaultFailure.stale }
    guard let index = record.identities.firstIndex(where: { $0.pubkey == pubkey }), let remote = record.identities[index].remote else { throw NativeVaultFailure.signerUnavailable }
    remote.clear(); record.identities[index].remote = nil
    if record.identities[index].selectedMethod == .nip46 { record.identities[index].selectedMethod = nil }
    try record.advance()
    return try await finishMethodMutation(record, digest: digest, store: store, authority: authority, current: current, revokePending: revokePending)
  }
  func deleteLocalKey(pubkey: String, vaultID: String, revision: UInt64,
    authority: any NativeSignerStorageAuthority, current: @Sendable () -> Bool,
    revokePending: @Sendable () -> Void) async throws -> String {
    try begin(); defer { busy = false }
    let store = try store(); var (record, digest) = try await readRecord(store); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current(), record.selectedPubkey == pubkey else { throw NativeVaultFailure.stale }
    guard let index = record.identities.firstIndex(where: { $0.pubkey == pubkey }), let secret = record.identities[index].secret else { throw NativeVaultFailure.localKeyUnavailable }
    secret.clear(); record.identities[index].secret = nil
    if record.identities[index].selectedMethod == .local { record.identities[index].selectedMethod = nil }
    try record.advance()
    return try await finishMethodMutation(record, digest: digest, store: store, authority: authority, current: current, revokePending: revokePending)
  }
  func commitRemote(pubkey: String, peerPubkey: String, relays: [String], clientKey: NativeVaultKey,
    vaultID: String, revision: UInt64, authority: any NativeSignerStorageAuthority,
    current: @Sendable () -> Bool, revokePending: @Sendable () -> Void) async throws -> String {
    try begin(); defer { busy = false }
    let store = try store(); var (record, digest) = try await readRecord(store); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current() else { throw NativeVaultFailure.stale }
    guard NativeVaultRecord.isPoint(pubkey), NativeVaultRecord.isPoint(peerPubkey),
      (1...3).contains(relays.count), Set(relays).count == relays.count,
      relays.allSatisfy({ (try? NativeSignerRelayPolicy.normalized($0)) == $0 }) else { throw NativeVaultFailure.invalidSignerConnection }
    let index: Int
    if let existing = record.identities.firstIndex(where: { $0.pubkey == pubkey }) {
      guard record.identities[existing].remote == nil else { throw NativeVaultFailure.signerAlreadyConnected }; index = existing
    } else {
      guard record.identities.count < 16 else { throw NativeVaultFailure.limitReached }
      let now = Date().timeIntervalSince1970 * 1000
      guard now >= 0, now <= Double(NativeVaultRecord.maximumRevision) else { throw NativeVaultFailure.storage }
      record.identities.append(.init(pubkey: pubkey, addedAt: UInt64(now), origin: .connected, secret: nil, selectedMethod: nil)); index = record.identities.count - 1
    }
    try clientKey.withPersistenceSecret { record.identities[index].remote = NativeVaultRemoteMethod(peerPubkey: peerPubkey, relays: relays, transportSecret: NativeVaultSecret($0)) }
    record.identities[index].selectedMethod = .nip46; record.selectedPubkey = pubkey; try record.advance()
    return try await finishMethodMutation(record, digest: digest, store: store, authority: authority, current: current, revokePending: revokePending)
  }
  struct RemoteCapability: Sendable {
    let pubkey: String, peer: String, relays: [String], key: NativeVaultKey
  }
  /// Clone only the transport key; decrypted record bytes are cleared before any network wait.
  func remoteCapability(pubkey: String, vaultID: String, revision: UInt64, current: @Sendable () -> Bool) async throws -> RemoteCapability {
    try begin(); defer { busy = false }
    var (record, _) = try await readRecord(try store()); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current(), record.selectedPubkey == pubkey else { throw NativeVaultFailure.denied }
    guard let remote = record.identities.first(where: { $0.pubkey == pubkey })?.remote else { throw NativeVaultFailure.signerUnavailable }
    return RemoteCapability(pubkey: pubkey, peer: remote.peerPubkey, relays: remote.relays, key: try NativeVaultKey(secret: remote.transportSecret.data))
  }
  func commitRemoteRefresh(pubkey: String, peerPubkey: String, relays: [String], clientKey: NativeVaultKey,
    vaultID: String, revision: UInt64, authority: any NativeSignerStorageAuthority,
    current: @Sendable () -> Bool, revokePending: @Sendable () -> Void) async throws -> String {
    try begin(); defer { busy = false }
    let store = try store(); var (record, digest) = try await readRecord(store); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current(), record.selectedPubkey == pubkey else { throw NativeVaultFailure.stale }
    guard let index = record.identities.firstIndex(where: { $0.pubkey == pubkey }),
      let remote = record.identities[index].remote, remote.peerPubkey == peerPubkey else { throw NativeVaultFailure.signerUnavailable }
    guard (1...3).contains(relays.count), Set(relays).count == relays.count,
      relays.allSatisfy({ (try? NativeSignerRelayPolicy.normalized($0)) == $0 }) else { throw NativeVaultFailure.invalidSignerConnection }
    let storedKey = try NativeVaultKey(secret: remote.transportSecret.data); defer { storedKey.destroy() }
    guard try storedKey.publicKey() == clientKey.publicKey() else { throw NativeVaultFailure.denied }
    guard Set(relays) != Set(remote.relays) else { return try record.publicSnapshot() }
    record.identities[index].remote = NativeVaultRemoteMethod(peerPubkey: remote.peerPubkey, relays: relays, transportSecret: remote.transportSecret)
    try record.advance()
    return try await finishMethodMutation(record, digest: digest, store: store, authority: authority, current: current, revokePending: revokePending)
  }
  func methods(pubkey: String, vaultID: String, revision: UInt64, current: @Sendable () -> Bool) async throws -> String {
    try begin(); defer { busy = false }
    var (record, _) = try await readRecord(try store()); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current() else { throw NativeVaultFailure.stale }; return try record.methodSnapshot(pubkey: pubkey)
  }
  func requireIdentity(pubkey: String, vaultID: String, revision: UInt64, current: @Sendable () -> Bool) async throws {
    try begin(); defer { busy = false }
    var (record, _) = try await readRecord(try store()); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current() else { throw NativeVaultFailure.stale }
    guard record.identities.contains(where: { $0.pubkey == pubkey }) else { throw NativeVaultFailure.notFound }
  }
  func backupSecret(pubkey: String, vaultID: String, revision: UInt64, current: @Sendable () -> Bool) async throws -> Data {
    try begin(); defer { busy = false }
    var (record, _) = try await readRecord(try store()); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current(), record.selectedPubkey == pubkey, let identity = record.identities.first(where: { $0.pubkey == pubkey }) else { throw NativeVaultFailure.denied }
    guard let secret = identity.secret else { throw NativeVaultFailure.localKeyUnavailable }
    return secret.copy()
  }
  func delete(pubkey: String, vaultID: String, revision: UInt64, authority: any NativeSignerStorageAuthority, current: @Sendable () -> Bool) async throws -> String {
    try begin(); defer { busy = false }
    let store = try store(); var (record, digest) = try await readRecord(store); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current() else { throw NativeVaultFailure.stale }
    guard record.selectedPubkey != pubkey else { throw NativeVaultFailure.deleteSelected }
    guard let index = record.identities.firstIndex(where: { $0.pubkey == pubkey }) else { throw NativeVaultFailure.notFound }
    record.identities[index].clear()
    record.identities.remove(at: index); try record.advance()
    try await persist(record, digest: digest, store: store, authority: authority)
    var (committed, _) = try await readRecord(store); defer { committed.clear() }
    guard current(), committed.revision == record.revision else { throw NativeVaultFailure.readback }
    return try committed.publicSnapshot()
  }
  func sign(event: ExactSignerEvent, vaultID: String, revision: UInt64, current: @escaping @Sendable () -> Bool,
    deadline: ContinuousClock.Instant = .now.advanced(by: .seconds(120)), dispatch: @escaping @Sendable (@Sendable () -> Void) throws -> Void = { $0() },
    state: NativeNip46DispatchState = NativeNip46DispatchState(), handoff: NativeNip46Handoff? = nil) async throws -> String {
    try begin(); defer { busy = false }
    var (record, _) = try await readRecord(try store()); defer { record.clear() }
    try record.assertExpected(vaultID: vaultID, revision: revision)
    guard current(), record.selectedPubkey == event.pubkey,
      let identity = record.identities.first(where: { $0.pubkey == event.pubkey }) else { throw NativeVaultFailure.denied }
    if identity.selectedMethod == .nip46, let remote = identity.remote {
      let key = try NativeVaultKey(secret: remote.transportSecret.data); defer { key.destroy() }
      let peer = remote.peerPubkey, relays = remote.relays
      // Destroy every decrypted record-owned scalar before network suspension.
      record.clear()
      let client: NativeNip46Client
      if let testingExchange {
        client = NativeNip46Client(key: key, peer: peer, handoff: handoff, exchange: testingExchange)
      } else {
        client = NativeNip46Client(key: key, peer: peer, handoff: handoff)
      }
      let signed = try await client.sign(event, relays: relays, deadline: deadline, current: current, dispatch: dispatch, state: state)
      guard current() else { throw state.possible ? NativeVaultFailure.signerUncertain : .stale }; return signed
    }
    guard identity.selectedMethod == .local, let secret = identity.secret else { throw NativeVaultFailure.signerUnavailable }
    let key = try NativeVaultKey(secret: secret.data); defer { key.destroy() }
    let signed = try key.sign(event)
    guard current() else { throw NativeVaultFailure.stale }; return signed
  }
}
