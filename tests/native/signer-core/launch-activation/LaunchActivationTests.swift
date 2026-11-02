import Foundation

@main struct LaunchActivationTests {
  @MainActor static var checks = [[String: Any]]()
  @MainActor static func expect(_ value: Bool, _ name: String) { checks.append(["name": name, "passed": value]) }
  @MainActor static func pause() async { try? await Task.sleep(for: .milliseconds(5)) }
  @MainActor static func result(_ task: Task<String, any Error>) async -> String {
    do { return try await task.value } catch let failure as NativeVaultFailure { return failure.rawValue } catch { return "unexpected" }
  }
  static func blockMainActor() { Thread.sleep(forTimeInterval: 0.04) }
  @MainActor static func main() async {
    do {
      let s = SessionUnderTest(active: true)
      expect((try? await s.open()) == "public-snapshot" && s.core.writes == 1, "active fast path preserves native permit")
    }
    do {
      let s = SessionUnderTest(), t = Task { try await s.open() }
      await pause(); expect(s.core.calls == 0, "inactive does not enter core")
      UIApplication.shared.applicationState = .active; s.notification()
      expect(await result(t) == "public-snapshot" && s.core.writes == 1, "inactive launch opens once after active notification")
    }
    do {
      let s = SessionUnderTest()
      UIApplication.shared.applicationState = .active; s.notification()
      expect((try? await s.open()) == "public-snapshot", "activation before wait registration is not lost")
    }
    do {
      let s = SessionUnderTest(), t = Task { try await s.open() }
      await pause()
      let duplicate = Task { try await s.open() }
      expect(await result(duplicate) == "busy", "duplicate open cannot replace first wait")
      UIApplication.shared.applicationState = .active; s.notification()
      expect(await result(t) == "public-snapshot" && s.core.calls == 1, "duplicate does not dispatch second core open")
    }
    do {
      let s = SessionUnderTest(), t = Task { try await s.open() }; t.cancel()
      expect(await result(t) == "denied" && s.core.calls == 0, "cancel before registration never dispatches")
    }
    do {
      let s = SessionUnderTest(), t = Task { try await s.open() }
      await pause(); UIApplication.shared.applicationState = .active; s.notification(); t.cancel()
      expect(await result(t) == "denied" && s.core.calls == 0, "cancel after ready before resumption never dispatches")
    }
    for loss in ["epoch", "owner", "closed", "background", "protected"] {
      let s = SessionUnderTest(), t = Task { try await s.open() }; await pause()
      switch loss {
      case "epoch": s.authority.gate.invalidateActions()
      case "owner": s.authority.owner = false
      case "closed": s.authority.gate.close()
      case "background": UIApplication.shared.applicationState = .background
      default: UIApplication.shared.isProtectedDataAvailable = false
      }
      if loss != "background" { UIApplication.shared.applicationState = .active }
      s.notification()
      expect(["denied", "stale"].contains(await result(t)) && s.core.calls == 0, "\(loss) while waiting never enters core")
    }
    do {
      let s = SessionUnderTest(protectedData: false)
      expect((try? await s.open()) == nil && s.core.calls == 0, "locked/protected unavailable is rejected immediately")
    }
    do {
      let gate = NativeVaultLaunchGate(); var calls = 0
      let t = Task { try await gate.open(state: { .waiting }, timeout: .milliseconds(20)) { calls += 1; return "bad" } }
      expect(await result(t) == "denied" && calls == 0 && !gate.isOpening, "timeout fails closed and releases flight")
    }
    for afterReady in [false, true] {
      let gate = NativeVaultLaunchGate(); var ready = false, calls = 0
      let t = Task { try await gate.open(state: { ready ? .ready : .waiting }, timeout: .milliseconds(20)) { calls += 1; return "bad" } }
      await pause()
      if afterReady { ready = true; gate.changed() }
      blockMainActor()
      if !afterReady { ready = true; gate.changed() }
      expect(await result(t) == "denied" && calls == 0, afterReady ? "deadline rechecked after ready resumption" : "late ready rejected before timeout task can execute")
    }
    do {
      let gate = NativeVaultLaunchGate(); var ready = false
      let first = Task { try await gate.open(state: { ready ? .ready : .waiting }, timeout: .milliseconds(20)) { "first" } }
      await pause(); first.cancel(); gate.cancel(); _ = await result(first)
      let second = Task { try await gate.open(state: { ready ? .ready : .waiting }, timeout: .seconds(1)) { "second" } }
      await pause(); ready = true; gate.changed(); gate.changed()
      expect(await result(second) == "second", "old cancellation and duplicate notification do not consume next wait")
    }
    let failed = checks.filter { ($0["passed"] as? Bool) != true }
    let report: [String: Any] = ["passed": failed.isEmpty, "assertions": checks.count, "failures": failed, "checks": checks,
      "scope": "Actual launch gate/mutation gate and extracted owning session admission methods; UIKit/Expo ownership/core storage dispatch are host doubles, not phone or protected-store proof"]
    print(String(data: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
    exit(failed.isEmpty ? 0 : 1)
  }
}
