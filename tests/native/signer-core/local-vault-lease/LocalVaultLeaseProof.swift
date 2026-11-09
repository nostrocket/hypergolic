import Foundation
import Synchronization

private enum ProofFailure: Error { case assertion(String) }
private let assertions = Mutex(0)
private func check(_ value: Bool, _ description: String) throws {
  guard value else { throw ProofFailure.assertion(description) }
  assertions.withLock { $0 += 1 }
}
private func denied(_ description: String, _ effect: @Sendable () async throws -> Void) async throws {
  do { try await effect() }
  catch { assertions.withLock { $0 += 1 }; return }
  throw ProofFailure.assertion(description)
}

/// In-memory Keychain and encrypted file ports. NativeSignerVaultStorage performs real encryption and record readback.
private final class Ports: KeychainBackend, EncryptedFiles, Sendable {
  enum Fault: Sendable { case none, beforeWrite, afterWrite }
  final class ReadGate: Sendable {
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    func waitEntered() -> Bool { entered.wait(timeout: .now() + 5) == .success }
  }
  private struct State: Sendable {
    var keys: [KeychainItem: Data] = [:]
    var record: Data?
    var fault = Fault.none
    var readGate: ReadGate?
  }
  private let state = Mutex(State())
  func hasLegacyStage() throws -> Bool { false }
  func read(_ item: KeychainItem) throws -> Data? {
    let gate = state.withLock { value in
      let current = value.readGate
      value.readGate = nil
      return current
    }
    if let gate {
      gate.entered.signal()
      guard gate.release.wait(timeout: .now() + 5) == .success else { throw StoreFailure.unavailable }
    }
    return state.withLock { $0.keys[item] }
  }
  func add(_ item: KeychainItem, value: Data) throws {
    try state.withLock {
      guard $0.keys[item] == nil else { throw StoreFailure.itemConflict }
      $0.keys[item] = value
    }
  }
  func updateReceipt(_ value: Data) throws { state.withLock { $0.keys[.receipt] = value } }
  func hasArtifacts() throws -> Bool { state.withLock { $0.record != nil } }
  func prepare() throws {}
  func read(_ slot: SecretSlot) throws -> Data? { state.withLock { $0.record } }
  func writeAtomically(_ slot: SecretSlot, data: Data) throws {
    try state.withLock {
      let fault = $0.fault
      $0.fault = .none
      if fault == .beforeWrite { throw StoreFailure.unavailable }
      $0.record = data
      if fault == .afterWrite { throw StoreFailure.unavailable }
    }
  }
  func remove(_ slot: SecretSlot) throws { state.withLock { $0.record = nil } }
  func failNextWrite(_ fault: Fault) { state.withLock { $0.fault = fault } }
  func corrupt() {
    state.withLock {
      if let count = $0.record?.count { $0.record![count - 1] ^= 1 }
    }
  }
  func blockNextRead() -> ReadGate {
    let gate = ReadGate()
    state.withLock { $0.readGate = gate }
    return gate
  }
}

/// Actual native epoch/mutation gate, with lifecycle events supplied by this host-only fixture.
private final class Owner: NativeSignerStorageAuthority, Sendable {
  let gate = NativeVaultMutationGate()
  let epoch: UInt64
  let ports = Ports()
  let storage: NativeSignerVaultStorage
  let core: NativeVaultCore
  init() throws {
    epoch = try gate.epoch()
    storage = .init(keychain: ports, files: ports, entropy: SystemEntropy())
    core = NativeVaultCore(testingStorage: storage)
  }
  func current() -> Bool { gate.current(epoch) }
  func foreground() { gate.update(foreground: true, protectedData: true) }
  func performMutation(_ operation: () throws -> Void) throws { try gate.mutate(epoch, operation: operation) }
  func capture() async throws -> NativeLocalVaultLease {
    let marker = try gate.localLeaseEpoch(epoch)
    return try await core.localLease(runtimeEpoch: epoch, current: { [self] in
      gate.currentLocalLease(epoch, localEpoch: marker)
    })
  }
  func open() async throws -> Snapshot { try await Snapshot(core.open(authority: self, current: { self.current() })) }
}
private struct Snapshot {
  let id: String
  let account: String
  let revision: UInt64
  init(_ raw: String) throws {
    guard let fields = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
      let id = fields["vaultId"] as? String, let account = fields["selectedPubkey"] as? String,
      let revision = fields["revision"] as? UInt64 else { throw ProofFailure.assertion("invalid real vault metadata") }
    self.id = id
    self.account = account
    self.revision = revision
  }
}
private func key(_ last: UInt8) throws -> NativeVaultKey {
  var scalar = Data(count: 32)
  scalar[31] = last
  defer { scalar.resetBytes(in: 0..<scalar.count) }
  return try NativeVaultKey(secret: scalar)
}
private func verify(_ lease: NativeLocalVaultLease, _ owner: Owner, _ persisted: Snapshot) throws -> NativeMeshIdentityStore.AccountLease {
  try check(lease.isCurrent && lease.account == persisted.account && lease.vaultId == persisted.id &&
    lease.vaultRevision == persisted.revision && lease.runtimeEpoch == owner.epoch, "exact persisted local owner metadata")
  let adapted = try NativeMeshIdentityStore.AccountLease(selectedLocal: lease)
  try check(adapted.isCurrent && adapted.account == persisted.account && adapted.epoch == Int64(owner.epoch) &&
    adapted.vaultRevision == Int64(persisted.revision), "typed Mesh adapter binds source metadata")
  return adapted
}
private func retired(_ prior: NativeLocalVaultLease, _ mesh: NativeMeshIdentityStore.AccountLease, _ description: String) async throws {
  try check(!prior.isCurrent && !mesh.isCurrent, description)
  try await denied("typed Mesh adapter accepted retired vault lease") {
    _ = try NativeMeshIdentityStore.AccountLease(selectedLocal: prior)
  }
}

@main struct LocalVaultLeaseProof {
  static func main() async throws {
    try await denied("uninstalled owner minted a lease") { _ = try await NativeLocalVaultLease.capture() }
    try await selectionAndLifecycle()
    try await suspendedRead()
    try await writeFailure(.beforeWrite)
    try await writeFailure(.afterWrite)
    try await boundsAndReadFailure()
    print("NATIVE_LOCAL_VAULT_ASSERTIONS=\(assertions.withLock { $0 })")
  }
  static func selectionAndLifecycle() async throws {
    let owner = try Owner()
    try await denied("inactive owner minted") { _ = try await owner.capture() }
    owner.foreground()
    try await denied("uninitialized owner minted") { _ = try await owner.capture() }
    let first = try await owner.open()
    try NativeLocalVaultLease.install(owner: owner, capture: { try await owner.capture() })
    try await denied("foreign provider replaced owner") {
      try NativeLocalVaultLease.install(owner: try Owner(), capture: { throw ProofFailure.assertion("foreign provider called") })
    }
    let initial = try await NativeLocalVaultLease.capture()
    let initialMesh = try verify(initial, owner, first)
    owner.gate.suspendLocalLeases()
    try check(owner.current(), "system authentication preserved actual signing epoch")
    try await denied("metadata lease minted during auth-preserved resign-active") { _ = try await owner.capture() }
    owner.foreground()
    try await retired(initial, initialMesh, "unobserved auth-preserved pause retired both brands")
    let stale = try await owner.capture()
    let staleMesh = try verify(stale, owner, first)
    try await denied("stale revision mutation accepted") {
      _ = try await owner.core.select(pubkey: first.account, vaultID: first.id, revision: first.revision + 1,
        authority: owner, current: { owner.current() })
    }
    try await retired(stale, staleMesh, "stale mutation retired both brands")
    let prior = try await owner.capture()
    let priorMesh = try verify(prior, owner, first)
    let importedKey = try key(7)
    defer { importedKey.destroy() }
    let b = try importedKey.publicKey()
    let publicOnly = try await Snapshot(owner.core.addPublicIdentity(pubkey: b, vaultID: first.id, revision: first.revision,
      authority: owner, current: { owner.current() }))
    try check(publicOnly.account == b, "public-only selected account control")
    try await denied("public-only identity minted") { _ = try await owner.capture() }
    let restored = try await Snapshot(owner.core.select(pubkey: first.account, vaultID: first.id, revision: publicOnly.revision,
      authority: owner, current: { owner.current() }))
    try await retired(prior, priorMesh, "selection A to public B to A retired both brands")
    let beforeRemote = try await owner.capture()
    let remoteMesh = try verify(beforeRemote, owner, restored)
    let client = try key(8)
    defer { client.destroy() }
    let remote = try await Snapshot(owner.core.commitRemote(pubkey: first.account, peerPubkey: b, relays: ["wss://relay.example.org"],
      clientKey: client, vaultID: first.id, revision: restored.revision, authority: owner, current: { owner.current() }, revokePending: {}))
    try await denied("retained local key bypassed selected NIP-46") { _ = try await owner.capture() }
    let local = try await Snapshot(owner.core.selectMethod(pubkey: first.account, method: .local, vaultID: first.id,
      revision: remote.revision, authority: owner, current: { owner.current() }, revokePending: {}))
    try await retired(beforeRemote, remoteMesh, "local to remote to local retired both brands")
    let beforeRefresh = try await owner.capture()
    let beforeRefreshMesh = try verify(beforeRefresh, owner, local)
    let refreshed = try await Snapshot(owner.core.commitRemoteRefresh(pubkey: first.account, peerPubkey: b,
      relays: ["wss://relay2.example.org"], clientKey: client, vaultID: first.id, revision: local.revision,
      authority: owner, current: { owner.current() }, revokePending: {}))
    try await retired(beforeRefresh, beforeRefreshMesh, "remote refresh with local backend preserved")
    let beforeImport = try await owner.capture()
    let beforeImportMesh = try verify(beforeImport, owner, refreshed)
    let imported = try await Snapshot(owner.core.commitImport(key: importedKey, vaultID: first.id, revision: refreshed.revision,
      authority: owner, current: { owner.current() }))
    try await retired(beforeImport, beforeImportMesh, "local import retired old leases")
    let importedLease = try await owner.capture()
    let importedMesh = try verify(importedLease, owner, imported)
    let removedKey = try await Snapshot(owner.core.deleteLocalKey(pubkey: b, vaultID: first.id, revision: imported.revision,
      authority: owner, current: { owner.current() }, revokePending: {}))
    try await denied("account without its local key minted") { _ = try await owner.capture() }
    try await retired(importedLease, importedMesh, "local key deletion retired both brands")
    let selected = try await Snapshot(owner.core.select(pubkey: first.account, vaultID: first.id, revision: removedKey.revision,
      authority: owner, current: { owner.current() }))
    let beforeDelete = try await owner.capture()
    let beforeDeleteMesh = try verify(beforeDelete, owner, selected)
    let deleted = try await Snapshot(owner.core.delete(pubkey: b, vaultID: first.id, revision: selected.revision,
      authority: owner, current: { owner.current() }))
    try await retired(beforeDelete, beforeDeleteMesh, "nonselected identity deletion retired both brands")
    let beforeBackground = try await owner.capture()
    let beforeBackgroundMesh = try verify(beforeBackground, owner, deleted)
    owner.gate.update(foreground: false, protectedData: false)
    owner.foreground()
    try await retired(beforeBackground, beforeBackgroundMesh, "background and protected-data loss prevent ABA")
    owner.gate.close()
    try await denied("retired runtime minted") { _ = try await NativeLocalVaultLease.capture() }
  }
  static func suspendedRead() async throws {
    let owner = try Owner()
    owner.foreground()
    let first = try await owner.open()
    let prior = try await owner.capture()
    let priorMesh = try verify(prior, owner, first)
    let paused = owner.ports.blockNextRead()
    let worker = Task { try await owner.capture() }
    defer { paused.release.signal() }
    let entered = await Task.detached { paused.waitEntered() }.value
    try check(entered, "production actor did not suspend for record read")
    try await denied("mutator overlapped a suspended vault read") {
      _ = try await owner.core.select(pubkey: first.account, vaultID: first.id, revision: first.revision,
        authority: owner, current: { owner.current() })
    }
    try await retired(prior, priorMesh, "rejected overlapping mutation retired old brand")
    owner.gate.suspendLocalLeases()
    owner.foreground()
    paused.release.signal()
    try await denied("capture across inactive/active transition produced stale result") { _ = try await worker.value }
    _ = try await verify(owner.capture(), owner, first)
  }
  private static func writeFailure(_ fault: Ports.Fault) async throws {
    let owner = try Owner()
    owner.foreground()
    let first = try await owner.open()
    let prior = try await owner.capture()
    let mesh = try verify(prior, owner, first)
    let imported = try key(9)
    defer { imported.destroy() }
    owner.ports.failNextWrite(fault)
    try await denied("storage fault acknowledged mutation") {
      _ = try await owner.core.commitImport(key: imported, vaultID: first.id, revision: first.revision,
        authority: owner, current: { owner.current() })
    }
    try await retired(prior, mesh, "failed or uncertain write retired both brands")
    let cold = try await Snapshot(NativeVaultCore(testingStorage: owner.storage).open(authority: owner, current: { owner.current() }))
    try check(cold.revision == first.revision + (fault == .afterWrite ? 1 : 0), "cold owner shows durable outcome")
    _ = try await verify(owner.capture(), owner, cold)
  }
  static func boundsAndReadFailure() async throws {
    let owner = try Owner()
    owner.foreground()
    let first = try await owner.open()
    let prior = try await owner.capture()
    let mesh = try verify(prior, owner, first)
    for _ in 1..<16 { _ = try await verify(owner.capture(), owner, first) }
    try await denied("seventeenth issued/current lease accepted") { _ = try await owner.capture() }
    owner.ports.corrupt()
    // Use a real record read because synchronous Swift lease checks cannot call the storage actor.
    try await denied("corrupt vault read succeeded") {
      _ = try await owner.core.snapshot(vaultID: first.id, revision: first.revision, current: { owner.current() })
    }
    try await retired(prior, mesh, "failed record read retired both brands")
  }
}
