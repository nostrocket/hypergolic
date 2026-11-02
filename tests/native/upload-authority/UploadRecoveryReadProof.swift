import Foundation

@main struct Proof {
  final class Clock: @unchecked Sendable { var value: Int64 = 1 }
  final class Memory: UploadRecoveryLedger.Store, @unchecked Sendable {
    var bytes: Data?
    func read() -> Data? { bytes }
    func write(_ value: Data) { bytes = value }
  }
  static func row(_ id: Int) throws -> UploadRecoveryLedger.Entry {
    try .init(uploadId: String(format: "00000000-0000-0000-0000-%012d", id), identity: String(repeating: "a", count: 64), publisher: String(repeating: "b", count: 64), appId: "app", destination: "https://files.example.com",
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", mimeType: "text/plain", size: 3, state: .unknown)
  }
  static func main() throws {
    var checks = 0
    func check(_ value: Bool) { checks += 1; precondition(value, "Recovery read check \(checks)") }
    let clock = Clock(), authority = UploadRecoveryReadAuthority(clock: {clock.value}), ledger = try UploadRecoveryLedger(store: Memory()), firstRow = try row(1)
    check(try ledger.start(firstRow)); check(authority.identity() == nil); check(authority.capture(firstRow) == nil)
    check(authority.register("realm1", identity: firstRow.identity)); authority.foreground(true)
    check(authority.identity() == firstRow.identity); let first = authority.capture(firstRow)!; check(authority.live(first)); check(authority.capture(firstRow) == nil)
    check(try authority.finish(first, status: 200, body: Data([1,2,4]), ledger: ledger) == .unknown)
    check(try ledger.blocks(identity: firstRow.identity, destination: firstRow.destination, sha256: firstRow.sha256)); check(!authority.live(first))
    let second = authority.capture(firstRow)!; check(try authority.finish(second, status: 200, body: Data([1,2,3]), ledger: ledger) == .present)
    check(try !ledger.blocks(identity: firstRow.identity, destination: firstRow.destination, sha256: firstRow.sha256))
    check(try authority.finish(second, status: 404, body: Data(), ledger: ledger) == .unknown)
    let absent = try row(2); check(try ledger.start(absent)); let background = authority.capture(absent)!
    authority.foreground(false); authority.foreground(true); check(!authority.live(background))
    check(try authority.finish(background, status: 404, body: Data(), ledger: ledger) == .unknown)
    check(try ledger.blocks(identity: absent.identity, destination: absent.destination, sha256: absent.sha256))
    let closed = authority.capture(absent)!; authority.revoke("realm1"); check(!authority.live(closed)); check(authority.identity() == nil)
    check(authority.register("realm2", identity: firstRow.identity)); let changed = authority.capture(absent)!
    check(authority.register("realm3", identity: String(repeating: "c", count: 64))); check(!authority.live(changed)); check(authority.capture(absent) == nil)
    check(authority.identity() == String(repeating: "c", count: 64)); authority.revoke("realm3"); check(authority.register("realm4", identity: firstRow.identity))
    let foundAbsent = authority.capture(absent)!; check(try authority.finish(foundAbsent, status: 404, body: Data([4,0,4]), ledger: ledger) == .absent)
    let fresh = try row(3); check(try ledger.start(fresh)); let expired = authority.capture(fresh)!
    clock.value = 60_001; check(!authority.live(expired)); check(try authority.finish(expired, status: 404, body: Data(), ledger: ledger) == .unknown)
    let cancelled = authority.capture(fresh)!; authority.cancel(cancelled); check(!authority.live(cancelled))
    let backwards = authority.capture(fresh)!; clock.value = 0; check(!authority.live(backwards)); clock.value = 100_000; check(authority.identity() == nil); check(authority.capture(fresh) == nil)
    print("{\"language\":\"Swift\",\"uploadRecoveryReadChecks\":\(checks),\"failed\":0,\"scope\":\"native read authority and injected store; no HTTP or app journey proof\"}")
  }
}
