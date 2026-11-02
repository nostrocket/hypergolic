import Foundation
import Testing
@testable import ApprovalTransport

private final class TestClock: NativeApprovalClock, @unchecked Sendable {
  private let lock = NSLock()
  private var value: Duration = .zero
  func now() -> Duration { lock.withLock { value } }
  func advance(_ seconds: Int64) { lock.withLock { value += .seconds(seconds) } }
}
private struct TestEntropy: NativeApprovalEntropy {
  func namespace() -> String { "approval-transport-test" }
}
private final class LeaseClock: @unchecked Sendable {
  private let lock = NSLock()
  private let origin = ContinuousClock.now
  private var offset: Duration = .zero
  func now() -> ContinuousClock.Instant { lock.withLock { origin.advanced(by: offset) } }
  func advance(_ seconds: Int64) { lock.withLock { offset += .seconds(seconds) } }
}
private final class TokenSource: @unchecked Sendable {
  private let lock = NSLock()
  private var next: Int
  init(start: Int = 0) { next = start }
  func token() -> String { lock.withLock { next += 1; return String(format: "00000000-0000-4000-8000-%012x", next) } }
}
private final class Scheduler: @unchecked Sendable {
  private let lock = NSLock()
  private var entries: [(Int, @Sendable () -> Void)] = []
  func add(_ seconds: Int, _ work: @escaping @Sendable () -> Void) { lock.withLock { entries.append((seconds, work)) } }
  var delays: [Int] { lock.withLock { entries.map(\.0) } }
}
private final class Replies: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String?] = []
  func add(_ value: String?) { lock.withLock { values.append(value) } }
  var all: [String?] { lock.withLock { values } }
}
private struct Harness {
  let generation: String
  let approvalClock: TestClock
  let leaseClock: LeaseClock
  let leases: CapabilityLeaseRegistry
  let scheduler: Scheduler
  let registry: ApprovalTransportRegistry

  init(generation: String = "generation-a", tokenSource: TokenSource = TokenSource()) {
    self.generation = generation
    approvalClock = TestClock()
    leaseClock = LeaseClock()
    leases = CapabilityLeaseRegistry(now: leaseClock.now)
    scheduler = Scheduler()
    let authority = NativeApprovalAuthority(testingClock: approvalClock, testingEntropy: TestEntropy())
    registry = ApprovalTransportRegistry(leases: leases, authority: authority,
      token: tokenSource.token, schedule: scheduler.add)
    #expect(leases.register(generation))
    #expect(registry.register(generation))
  }

  func focusAndForeground() {
    registry.setForeground(true)
    registry.setFocused(generation, active: true)
  }

  func admit(_ sequence: UInt64, id: String? = "wire-id", snapshot: String = "{\"registration\":{},\"request\":\"exact\"}",
             replies: Replies = Replies()) -> (String, Replies) {
    #expect(leases.consumeSequence(generation, sequence: sequence))
    let token = registry.admit(generation, snapshot: snapshot, wireId: id) { replies.add($0) }
    return (try! #require(token), replies)
  }
}

private func waitForReplies(_ replies: Replies, count: Int) async {
  for _ in 0..<100 {
    if replies.all.count == count { return }
    try? await Task.sleep(for: .milliseconds(5))
  }
}

@Test func interleavedSequenceAndIndependentDeadlines() async {
  let harness = Harness()
  harness.focusAndForeground()
  let ordinary = try! #require(harness.leases.admit(harness.generation, sequence: 1, snapshot: "ordinary"))
  let (approval, replies) = harness.admit(2)
  #expect(!harness.leases.consumeSequence(harness.generation, sequence: 2))
  #expect(harness.leases.admit(harness.generation, sequence: 3, snapshot: "next") != nil)
  #expect(harness.scheduler.delays == [600])
  #expect(harness.registry.take(approval) != nil)

  harness.leaseClock.advance(26)
  #expect(!harness.leases.isActive(ordinary))
  #expect(harness.registry.isLive(approval))
  harness.approvalClock.advance(599)
  #expect(harness.registry.isLive(approval))
  harness.approvalClock.advance(1)
  harness.registry.sweep()
  await waitForReplies(replies, count: 1)
  #expect(!harness.registry.isLive(approval))
  let denial = try! #require(replies.all.first!)
  let value = try! #require(JSONSerialization.jsonObject(with: Data(denial.utf8)) as? [String: Any])
  #expect(value["id"] as? String == "wire-id")
  #expect(value["error"] as? String == "approval denied")
}

@Test func pendingSurvivesBackgroundButApprovedGrantIsRevoked() async {
  let harness = Harness()
  harness.focusAndForeground()
  let (token, replies) = harness.admit(1)
  #expect(harness.registry.take(token) != nil)
  harness.registry.setForeground(false)
  #expect(harness.registry.isLive(token))
  #expect(!harness.registry.mayReview(token))
  harness.registry.setForeground(true)
  #expect(!harness.registry.mayReview(token), "Background pauses review until explicit resume")
  harness.registry.resume()
  #expect(harness.registry.mayReview(token))
  #expect(harness.registry.approve(token))
  #expect(harness.registry.isApproved(token))
  harness.registry.setForeground(false)
  await waitForReplies(replies, count: 1)
  #expect(!harness.registry.isLive(token))
  #expect(!harness.registry.isApproved(token))
}

@Test func focusChangeRevokesApprovedGrantButRetainsPendingRows() async {
  let harness = Harness()
  harness.focusAndForeground()
  let (approved, approvedReplies) = harness.admit(1, id: "approved")
  let (pending, _) = harness.admit(2, id: "pending")
  #expect(harness.registry.take(approved) != nil)
  #expect(harness.registry.take(pending) != nil)
  #expect(harness.registry.approve(approved))
  #expect(harness.leases.register("generation-b"))
  #expect(harness.registry.register("generation-b"))
  harness.registry.setFocused("generation-b", active: true)
  await waitForReplies(approvedReplies, count: 1)
  #expect(!harness.registry.isApproved(approved))
  #expect(harness.registry.isLive(pending))
  #expect(!harness.registry.mayReview(pending))
  harness.registry.setFocused("generation-b", active: false)
  harness.registry.setFocused(harness.generation, active: true)
  #expect(harness.registry.mayReview(pending))
}

@Test func takeApproveAndReplayAreOneUseAndStaleTokensCannotAffectReplacement() {
  let harness = Harness()
  harness.focusAndForeground()
  let (token, _) = harness.admit(1)
  #expect(harness.registry.take(token) != nil)
  #expect(harness.registry.take(token) == nil)
  #expect(harness.registry.approve(token))
  #expect(!harness.registry.approve(token))
  #expect(harness.registry.isApproved(token))
  harness.registry.revoke(harness.generation)
  #expect(!harness.registry.isLive(token))
  #expect(!harness.registry.isApproved(token))
  #expect(harness.registry.register(harness.generation))
  harness.focusAndForeground()
  let (replacement, _) = harness.admit(2, id: "replacement")
  #expect(harness.registry.take(replacement) != nil)
  harness.registry.cancel(token)
  harness.registry.finish(token, response: nil)
  #expect(harness.registry.isLive(replacement))
  #expect(!harness.registry.isLive("00000000-0000-4000-8000-ffffffffffff"))
}

@Test func tokenFromForeignTransportCannotAffectAnotherOwner() {
  let first = Harness(generation: "first", tokenSource: TokenSource(start: 10))
  let second = Harness(generation: "second", tokenSource: TokenSource(start: 20))
  first.focusAndForeground(); second.focusAndForeground()
  let (foreign, _) = first.admit(1)
  let (local, _) = second.admit(1)
  #expect(first.registry.take(foreign) != nil)
  #expect(second.registry.take(local) != nil)
  second.registry.cancel(foreign)
  second.registry.finish(foreign, response: nil)
  #expect(second.registry.isLive(local))
  #expect(first.registry.isLive(foreign))
}

@Test func dismissRejectsCurrentAndPausesRemainingReview() async {
  let harness = Harness()
  harness.focusAndForeground()
  let (first, firstReplies) = harness.admit(1, id: "first")
  let (second, _) = harness.admit(2, id: "second")
  #expect(harness.registry.take(first) != nil)
  #expect(harness.registry.take(second) != nil)
  #expect(harness.registry.mayReview(first))
  harness.registry.dismiss(first)
  await waitForReplies(firstReplies, count: 1)
  #expect(!harness.registry.isLive(first))
  #expect(!harness.registry.mayReview(second))
  harness.registry.resume()
  #expect(harness.registry.mayReview(second))
}

@Test func terminalSuccessChecksCorrelationAndConsumesBeforeReply() async {
  let harness = Harness()
  harness.focusAndForeground()
  let replies = Replies()
  let (token, _) = harness.admit(1, id: "publish-1", replies: replies)
  #expect(harness.registry.take(token) != nil)
  #expect(harness.registry.approve(token))
  let response = "{\"type\":\"relay.publish.result\",\"id\":\"publish-1\",\"ok\":true,\"eventId\":\"" +
    String(repeating: "a", count: 64) + "\"}"
  harness.registry.finish(token, response: response)
  await waitForReplies(replies, count: 1)
  #expect(replies.all == [response])
  #expect(!harness.registry.isLive(token))
  #expect(!harness.registry.isApproved(token))
}

@MainActor @Test func terminalSuccessIsRecheckedAfterBackgroundBeforeMainActorDelivery() async {
  let harness = Harness()
  harness.focusAndForeground()
  let (token, replies) = harness.admit(1, id: "publish-race")
  #expect(harness.registry.take(token) != nil)
  #expect(harness.registry.approve(token))
  let response = "{\"type\":\"relay.publish.result\",\"id\":\"publish-race\",\"ok\":true}"
  // finish queues its final guard on this actor. Revocation wins before this turn yields.
  harness.registry.finish(token, response: response)
  harness.registry.setForeground(false)
  await waitForReplies(replies, count: 1)
  let denial = try! #require(replies.all.first!)
  let value = try! #require(JSONSerialization.jsonObject(with: Data(denial.utf8)) as? [String: Any])
  #expect(value["id"] as? String == "publish-race")
  #expect(value["ok"] as? Bool == false)
  #expect(replies.all == [denial])
}

@Test func wrongOrMalformedTerminalResponseFailsClosedWithExactDenial() async {
  for (index, response) in [
    "{\"type\":\"relay.publish.result\",\"id\":\"wrong\",\"ok\":true}",
    "{\"type\":\"relay.publish.result\",\"id\":\"publish-1\"}",
    "not-json",
  ].enumerated() {
    let harness = Harness(generation: "generation-\(index)")
    harness.focusAndForeground()
    let (token, replies) = harness.admit(1, id: "publish-1")
    #expect(harness.registry.take(token) != nil)
    #expect(harness.registry.approve(token))
    harness.registry.finish(token, response: response)
    await waitForReplies(replies, count: 1)
    let denial = try! #require(replies.all.first!)
    let value = try! #require(JSONSerialization.jsonObject(with: Data(denial.utf8)) as? [String: Any])
    #expect(value["type"] as? String == "relay.publish.result")
    #expect(value["id"] as? String == "publish-1")
    #expect(value["ok"] as? Bool == false)
    #expect(!harness.registry.isLive(token))
  }
}

@Test func malformedWireIdUsesNullDenialAndCleansUp() async {
  let harness = Harness()
  harness.focusAndForeground()
  let (token, replies) = harness.admit(1, id: nil)
  #expect(harness.registry.take(token) != nil)
  harness.registry.cancel(token)
  await waitForReplies(replies, count: 1)
  #expect(replies.all.count == 1)
  #expect(replies.all[0] == nil)
  #expect(!harness.registry.isLive(token))
}

@Test func exactConfigurationDomainsAndPublishRecognition() throws {
  func raw(fixture: String, domains: [String]) throws -> String {
    let value: [String: Any] = ["sessionId": "session", "epoch": 1,
      "user": String(repeating: "1", count: 64), "publisher": String(repeating: "2", count: 64),
      "appId": "approval-lab", "version": String(repeating: "3", count: 64),
      "instanceId": "instance", "fixture": fixture, "domains": domains]
    return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
  }
  let archive = try CapabilityConfiguration(raw(fixture: "approval-lab-v1",
    domains: ["identity", "relay", "theme"]), generation: "generation")
  #expect(archive.fixture == "approval-lab-v1")
  #expect(archive.approvalWireId("{\"type\":\"relay.publish\",\"id\":\"archived\",\"event\":{}}").wireId == "archived")
  let archive2 = try CapabilityConfiguration(raw(fixture: "approval-lab-v2",
    domains: ["identity", "relay", "theme"]), generation: "generation")
  #expect(archive2.fixture == "approval-lab-v2")
  #expect(archive2.approvalWireId("{\"type\":\"relay.publish\",\"id\":\"archive2\",\"event\":{}}").wireId == "archive2")
  let archive3 = try CapabilityConfiguration(raw(fixture: "approval-lab-v3",
    domains: ["identity", "relay", "theme"]), generation: "generation")
  #expect(archive3.fixture == "approval-lab-v3")
  #expect(archive3.domains == Set(["identity", "relay", "theme"]))
  #expect(archive3.approvalWireId("{\"type\":\"relay.publish\",\"id\":\"archive3\",\"event\":{}}").wireId == "archive3")
  for fixture in ["approval-lab-v1", "approval-lab-v2", "approval-lab-v3"] {
    #expect(throws: (any Error).self) {
      _ = try CapabilityConfiguration(raw(fixture: fixture, domains: ["identity", "theme"]), generation: "generation")
    }
    #expect(throws: (any Error).self) {
      _ = try CapabilityConfiguration(raw(fixture: fixture, domains: ["identity", "relay", "theme", "storage"]), generation: "generation")
    }
    #expect(throws: (any Error).self) {
      _ = try CapabilityConfiguration(raw(fixture: fixture, domains: ["identity", "relay", "theme", "relay"]), generation: "generation")
    }
  }
  #expect(throws: (any Error).self) {
    _ = try CapabilityConfiguration(raw(fixture: "approval-lab-v4", domains: ["identity", "relay", "theme"]), generation: "generation")
  }
  let archivedFeed = try CapabilityConfiguration(raw(fixture: "feed-lab-v1",
    domains: ["identity", "outbox", "relay", "theme"]), generation: "feed-generation")
  #expect(archivedFeed.fixture == "feed-lab-v1")
  for domains in [["identity", "relay", "theme"],
    ["identity", "outbox", "relay", "theme", "storage"],
    ["identity", "outbox", "relay", "theme", "relay"]] {
    #expect(throws: (any Error).self) {
      _ = try CapabilityConfiguration(raw(fixture: "feed-lab-v1", domains: domains), generation: "generation")
    }
  }
  #expect(throws: (any Error).self) {
    _ = try CapabilityConfiguration(raw(fixture: "feed-lab-v2", domains: ["identity", "outbox", "relay", "theme"]), generation: "generation")
  }
  let configuration = try CapabilityConfiguration(raw(fixture: "approval-lab",
    domains: ["identity", "relay", "theme"]), generation: "generation")
  #expect(configuration.approvalWireId("{\"type\":\"relay.publish\",\"id\":\"exact\",\"event\":{}}")
    .wireId == "exact")
  #expect(configuration.approvalWireId("{\"type\":\"relay.query\",\"id\":\"read\"}").recognized == false)
  #expect(configuration.approvalWireId("{\"type\":\"relay.publish\",\"id\":42}").recognized)
  #expect(configuration.approvalWireId("{\"type\":\"relay.publish\",\"id\":42}").wireId == nil)
  #expect(throws: (any Error).self) {
    _ = try CapabilityConfiguration(raw(fixture: "approval-lab", domains: ["identity", "theme"]), generation: "generation")
  }
  #expect(throws: (any Error).self) {
    _ = try CapabilityConfiguration(raw(fixture: "state-lab", domains: ["identity", "storage", "relay", "theme"]), generation: "generation")
  }
}
