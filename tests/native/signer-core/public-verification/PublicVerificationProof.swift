import Foundation
final class ProofBox: @unchecked Sendable {
  let lock = NSLock(); private var value: UInt64 = 0
  func read() -> UInt64 { lock.withLock { value } }
  func set(_ next: UInt64) { lock.withLock { value = next } }
  func increment() { lock.withLock { value += 1 } }
}
@main struct Proof {
  static func main() throws {
    var checks = 0, number = 0
    func id() -> String { number += 1; return String(format: "00000000-0000-4000-8000-%012d", number) }
    func ok(_ value: Bool) { checks += 1; precondition(value, "proof \(checks)") }
    func denied(_ action: () throws -> Void) { do { try action(); preconditionFailure("expected denial") } catch { checks += 1 } }
    func tuple(_ p: String, _ d: String, _ s: String) -> String { "[[\"\(p)\",\"\(d)\",\"\(s)\"]]" }
    let raw = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    let real = NativePublicVerification(); real.setForeground(true)
    for line in try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8).split(separator: "\n") {
      let fields = line.split(separator: "\t").map(String.init), operation = id()
      let result = try real.run(real.begin(id: operation, raw: tuple(fields[0], fields[1], fields[2]), milliseconds: 1000, active: { true }))
      ok(result.contains("\"operationId\":\"\(operation)\"")); ok(result.contains("[\(fields[3].lowercased())]"))
    }
    let zero = String(repeating: "0", count: 64), signature = String(repeating: "0", count: 128)
    let one = tuple(zero, zero, signature)
    let owner = NativePublicVerification(clock: { 0 }, verifier: { _,_,_ in true })
    denied { _ = try owner.begin(id: id(), raw: one, milliseconds: 1000, active: { true }) }
    owner.setForeground(true)
    for bad in ["[]", "[1]", one + " ", one.replacingOccurrences(of: "0000", with: "zzzz"), "[" + Array(repeating: String(one.dropFirst().dropLast()), count: 201).joined(separator: ",") + "]"] {
      let job = try owner.begin(id: id(), raw: bad, milliseconds: 1000, active: { true }); denied { _ = try owner.run(job) }
    }
    denied { _ = try owner.begin(id: id(), raw: String(repeating: "x", count: 65_537), milliseconds: 1000, active: { true }) }
    let edge = try owner.begin(id: id(), raw: String(repeating: "x", count: 65_536), milliseconds: 1000, active: { true }); denied { _ = try owner.run(edge) }
    let full = "[" + Array(repeating: String(one.dropFirst().dropLast()), count: 200).joined(separator: ",") + "]"
    ok(full.utf8.count == 53_401); ok(try owner.run(owner.begin(id: id(), raw: full, milliseconds: 1000, active: { true })).contains("true,true"))
    let cancelled = id(); owner.cancel(cancelled); denied { _ = try owner.begin(id: cancelled, raw: one, milliseconds: 1000, active: { true }) }
    let abandoned = try owner.begin(id: id(), raw: one, milliseconds: 1000, active: { true }); owner.abandon(abandoned); denied { _ = try owner.run(abandoned) }
    let paused = try owner.begin(id: id(), raw: one, milliseconds: 1000, active: { true }); owner.setForeground(false); owner.setForeground(true); denied { _ = try owner.run(paused) }
    let clock = ProofBox()
    let timed = NativePublicVerification(clock: { clock.read() }, verifier: { _,_,_ in clock.set(1_000_000); return true }); timed.setForeground(true)
    let deadline = try timed.begin(id: id(), raw: one, milliseconds: 1, active: { true }); denied { _ = try timed.run(deadline) }
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), group = DispatchGroup(), exits = ProofBox()
    let blocked = NativePublicVerification(verifier: { _,_,_ in entered.signal(); release.wait(); return true }); blocked.setForeground(true)
    let a = try blocked.begin(id: id(), raw: one, milliseconds: 15000, active: { true }), b = try blocked.begin(id: id(), raw: one, milliseconds: 15000, active: { true })
    for job in [a,b] { group.enter(); DispatchQueue.global().async { defer { group.leave() }; do { _ = try blocked.run(job) } catch { exits.increment() } } }
    ok(entered.wait(timeout: .now() + 2) == .success); ok(entered.wait(timeout: .now() + 2) == .success)
    blocked.cancel(a.id); blocked.close(); denied { _ = try owner.begin(id: id(), raw: one, milliseconds: 1000, active: { true }) }
    release.signal(); release.signal(); ok(group.wait(timeout: .now() + 2) == .success); ok(exits.read() == 2)
    ok(try owner.run(owner.begin(id: id(), raw: one, milliseconds: 1000, active: { true })).contains("true"))
    let resumed = try owner.begin(id: id(), raw: one, milliseconds: 1000, active: { true }); _ = try owner.run(resumed)
    owner.setForeground(false); owner.setForeground(true); denied { try owner.delivery(resumed) }
    let overflow = try owner.begin(id: id(), raw: one, milliseconds: 1000, active: { true }); _ = try owner.run(overflow)
    for _ in 0..<64 { owner.cancel(id()) }; owner.cancel(overflow.id); denied { try owner.delivery(overflow) }
    var total = 0.0
    for round in 0..<9 {
      let start = DispatchTime.now().uptimeNanoseconds
      let result = try real.run(real.begin(id: id(), raw: raw, milliseconds: 15000, active: { true }))
      let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
      ok(!result.contains("false")); if round >= 2 { total += ms }
    }
    print("{\"checks\":\(checks),\"events\":80,\"nativeOwnerParseHexAndSchnorrMeanMs\":\(total / 7),\"scope\":\"macOS Swift/C host, not Expo bridge/device\"}")
  }
}
