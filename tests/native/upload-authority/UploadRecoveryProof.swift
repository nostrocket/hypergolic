import Foundation

@main struct UploadRecoveryProof {
  final class Memory: UploadRecoveryLedger.Store, @unchecked Sendable {
    var bytes: Data?, failWrite = false, loseWrite = false, writes = 0
    func read() throws -> Data? { bytes }
    func write(_ value: Data) throws { writes += 1; if failWrite { throw UploadRecoveryLedger.Failure.unavailable }; if !loseWrite { bytes = value } }
  }
  static func main() throws {
    var checks = 0
    func check(_ value: @autoclosure () -> Bool) { checks += 1; precondition(value(), "Recovery check \(checks)") }
    func denied(_ action: () throws -> Void) { do { try action(); preconditionFailure("Unavailable recovery accepted") } catch { check(true) } }
    let identity = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", server = "https://files.example.com"
    func entry(_ number: Int) throws -> UploadRecoveryLedger.Entry {
      try .init(uploadId: String(format: "00000000-0000-0000-0000-%012x", number), identity: identity, publisher: identity, appId: "upload-lab-λ",
        destination: server, sha256: String(repeating: "0", count: 64 - String(number, radix: 16).count) + String(number, radix: 16), mimeType: "image/png", size: 71, state: .unknown)
    }
    let memory = Memory(), ledger = try UploadRecoveryLedger(store: memory), first = try entry(1)
    let empty = try ledger.list(identity); check(empty.isEmpty); let started = try ledger.start(first); check(started); check(memory.writes == 1)
    let blocked = try ledger.blocks(identity: identity, destination: server, sha256: first.sha256); check(blocked)
    let again = try ledger.start(first); check(!again); check(memory.writes == 1)
    let duplicate = try UploadRecoveryLedger.Entry(uploadId: entry(2).uploadId, identity: identity, publisher: identity, appId: "other-caller", destination: server,
      sha256: first.sha256, mimeType: "image/png", size: 71, state: .unknown)
    let repeated = try ledger.start(duplicate); check(!repeated)
    let elsewhere = try ledger.blocks(identity: identity, destination: "https://other.example.com", sha256: first.sha256); check(!elsewhere)
    let otherIdentity = try ledger.blocks(identity: String(repeating: "0", count: 64), destination: server, sha256: first.sha256); check(!otherIdentity)
    let restarted = try UploadRecoveryLedger(store: memory), before = try ledger.list(identity), after = try restarted.list(identity); check(before == after)
    let restartRepeat = try restarted.start(duplicate); check(!restartRepeat)
    let wrong = try restarted.settle(duplicate, state: .absent); check(!wrong)
    let unresolved = try restarted.settle(first, state: .unknown); check(!unresolved)
    let settled = try restarted.settle(first, state: .absent); check(settled)
    let stale = try restarted.settle(first, state: .present); check(!stale)
    let unblocked = try restarted.blocks(identity: identity, destination: server, sha256: first.sha256); check(!unblocked)
    let fresh = try restarted.start(duplicate); check(fresh)
    let fullStore = Memory(), full = try UploadRecoveryLedger(store: fullStore)
    for number in 1...UploadRecoveryLedger.maximumRecords { let accepted = try full.start(entry(number)); check(accepted) }
    let overQuota = try full.start(entry(33)); check(!overQuota)
    let restored = try UploadRecoveryLedger(store: fullStore).list(identity); check(restored.count == 32)
    let confirmed = try full.settle(entry(1), state: .confirmed); check(confirmed)
    let admitted = try full.start(entry(33)); check(admitted)
    let kept = try full.list(identity); check(kept.count == 32); check(!kept.contains {$0.uploadId == first.uploadId})
    let second = try entry(2); check(kept.contains {$0.uploadId == second.uploadId})
    let failureStore = Memory(), failed = try UploadRecoveryLedger(store: failureStore); failureStore.failWrite = true
    denied { _ = try failed.start(first) }; failureStore.failWrite = false; denied { _ = try failed.start(first) }; denied { _ = try failed.list(identity) }
    let lostStore = Memory(), lost = try UploadRecoveryLedger(store: lostStore); lostStore.loseWrite = true; denied { _ = try lost.start(first) }
    let encoded = try UploadRecoveryLedger.encode([first]), decoded = try UploadRecoveryLedger.decode(encoded); check(decoded == [first])
    for length in 0..<encoded.count { denied { _ = try UploadRecoveryLedger.decode(Data(encoded.prefix(length))) } }
    for index in 0..<encoded.count { var corrupt = encoded; corrupt[index] ^= 1; denied { _ = try UploadRecoveryLedger.decode(corrupt) } }
    let corruptStore = Memory(); corruptStore.bytes = Data(count: 44); denied { _ = try UploadRecoveryLedger(store: corruptStore) }
    let root = URL(fileURLWithPath: CommandLine.arguments[1]); try encoded.write(to: root.appendingPathComponent("swift-recovery.bin"))
    let java = try UploadRecoveryLedger.decode(Data(contentsOf: root.appendingPathComponent("java-recovery.bin"))); check(java == [first])
    print("{\"language\":\"Swift\",\"uploadRecoveryChecks\":\(checks),\"failed\":0,\"scope\":\"native ledger core; injected memory store, no durable disk or network proof\"}")
  }
}
