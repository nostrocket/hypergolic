import Foundation
import Testing
@testable import NativeApprovalAuthority

private final class TestClock: NativeApprovalClock, @unchecked Sendable {
  private let lock = NSLock()
  private var value: Duration = .zero
  func now() -> Duration { lock.withLock { value } }
  func advance(seconds: Int64) { lock.withLock { value += .seconds(seconds) } }
  func rewind(seconds: Int64) { lock.withLock { value -= .seconds(seconds) } }
}
private struct TestEntropy: NativeApprovalEntropy {
  let value: String
  func namespace() -> String { value }
}

private func authority(_ namespace: String = "private-test-namespace") -> (NativeApprovalAuthority, TestClock) {
  let clock = TestClock()
  return (NativeApprovalAuthority(testingClock: clock, testingEntropy: TestEntropy(value: namespace)), clock)
}
private func ready(_ owner: NativeApprovalAuthority, generation: String = "generation-a") -> NativeApprovalSessionHandle {
  let session = owner.register(generation: generation)!
  owner.setForeground(true)
  #expect(owner.setFocused(session))
  return session
}

@Test func approvalIsTakenOnceButRemainsLiveUntilFinish() {
  let (owner, _) = authority(), session = ready(owner)
  let abandoned = owner.admit(session, snapshot: "abandoned")!
  let abandonedApproval = owner.approve(abandoned)!
  #expect(owner.finish(abandonedApproval))
  #expect(!owner.finish(abandonedApproval))

  let request = owner.admit(session, snapshot: "{\"kind\":1}")!
  #expect(owner.currentReview() == .init(request: request, snapshot: "{\"kind\":1}"))
  let approval = owner.approve(request)!
  #expect(owner.currentReview() == nil)
  #expect(owner.isApproved(approval))
  #expect(owner.take(approval) == "{\"kind\":1}")
  #expect(owner.take(approval) == nil)
  #expect(owner.isApproved(approval))
  #expect(owner.finish(approval))
  #expect(!owner.isApproved(approval))
}

@Test func focusAndForegroundPreservePendingButRevokeApproved() {
  let (owner, _) = authority()
  let first = ready(owner), second = owner.register(generation: "generation-b")!
  let approvedFirstRequest = owner.admit(first, snapshot: "first-approved")!
  let retainedFirst = owner.admit(first, snapshot: "first-pending")!
  let firstApproval = owner.approve(approvedFirstRequest)!
  #expect(owner.currentReview() == nil)
  #expect(owner.approve(retainedFirst) == nil)

  #expect(owner.setFocused(second))
  #expect(!owner.isApproved(firstApproval))
  let approvedSecondRequest = owner.admit(second, snapshot: "second-approved")!
  let retainedSecond = owner.admit(second, snapshot: "second-pending")!
  #expect(owner.currentReview()?.request == approvedSecondRequest)
  let secondApproval = owner.approve(approvedSecondRequest)!
  owner.setForeground(false)
  #expect(!owner.isApproved(secondApproval))
  #expect(!owner.resumeReview())
  #expect(owner.currentReview() == nil)
  owner.setForeground(true)
  #expect(owner.currentReview() == nil)
  #expect(owner.resumeReview())
  #expect(owner.currentReview()?.request == retainedSecond)
  #expect(owner.setFocused(first))
  #expect(owner.currentReview()?.request == retainedFirst)
}

@Test func dismissPausesAndStaleHandlesCannotPauseLaterReview() {
  let (owner, _) = authority(), session = ready(owner)
  let dismissed = owner.admit(session, snapshot: "dismiss")!
  #expect(owner.currentReview()?.request == dismissed)
  #expect(owner.dismiss(dismissed))
  #expect(owner.currentReview() == nil)
  #expect(!owner.dismiss(dismissed))
  let next = owner.admit(session, snapshot: "next")!
  #expect(owner.currentReview() == nil)
  #expect(owner.resumeReview())
  #expect(owner.currentReview()?.request == next)
}

@Test func exactCancellationCleansOnlyItsHandleWithoutPausing() {
  let (owner, _) = authority(), session = ready(owner)
  let first = owner.admit(session, snapshot: "first")!
  let second = owner.admit(session, snapshot: "second")!
  #expect(owner.contains(first))
  #expect(owner.currentReview()?.request == first)
  #expect(owner.cancel(first))
  #expect(!owner.contains(first))
  #expect(owner.currentReview()?.request == second)
  _ = owner.approve(second)!
  #expect(owner.cancel(second), "The exact request handle also cancels its approved state")
  #expect(!owner.cancel(second))

  let third = owner.admit(session, snapshot: "third")!
  let approval = owner.approve(third)!
  #expect(owner.cancel(approval))
  #expect(!owner.cancel(approval))
  #expect(owner.take(approval) == nil)
}

@Test func teardownAndGenerationReuseRejectEveryOldHandle() {
  let (owner, _) = authority(), old = ready(owner)
  let oldRequest = owner.admit(old, snapshot: "old")!
  #expect(owner.currentReview()?.request == oldRequest)
  let oldApproval = owner.approve(oldRequest)!
  let oldPending = owner.admit(old, snapshot: "old-pending")!
  #expect(owner.teardown(old))
  let replacement = ready(owner, generation: "generation-a")
  let replacementRequest = owner.admit(replacement, snapshot: "new")!
  #expect(!owner.setFocused(old))
  #expect(!owner.isApproved(oldApproval))
  #expect(owner.take(oldApproval) == nil)
  #expect(!owner.cancel(oldRequest))
  #expect(!owner.cancel(oldPending))
  #expect(owner.currentReview()?.request == replacementRequest)
}

@Test func exactLimitsAndSnapshotBoundsAreEnforced() {
  let (owner, _) = authority()
  var sessions: [NativeApprovalSessionHandle] = []
  for index in 0..<4 { sessions.append(owner.register(generation: "g-\(index)")!) }
  for session in sessions {
    for index in 0..<4 { #expect(owner.admit(session, snapshot: "request-\(index)") != nil) }
    #expect(owner.admit(session, snapshot: "overflow") == nil)
  }
  let fifth = owner.register(generation: "g-5")!
  #expect(owner.admit(fifth, snapshot: "global-overflow") == nil)
  #expect(owner.teardown(sessions[0]))
  #expect(owner.admit(fifth, snapshot: "after-capacity") != nil)
  #expect(owner.admit(fifth, snapshot: "") == nil)
  #expect(owner.admit(fifth, snapshot: String(repeating: "x", count: NativeApprovalAuthority.maximumSnapshotBytes + 1)) == nil)
}

@Test func expiryIsFromAdmissionAndReturnsExactPhase() {
  let (owner, clock) = authority(), session = ready(owner)
  let pending = owner.admit(session, snapshot: "pending")!
  #expect(owner.contains(pending))
  clock.advance(seconds: 599)
  #expect(owner.currentReview()?.request == pending)
  clock.advance(seconds: 1)
  #expect(owner.expire() == [.request(pending)])
  #expect(!owner.contains(pending))
  #expect(!owner.cancel(pending))

  let approvedRequest = owner.admit(session, snapshot: "approved")!
  #expect(owner.currentReview()?.request == approvedRequest)
  let approval = owner.approve(approvedRequest)!
  #expect(owner.take(approval) == "approved")
  clock.advance(seconds: 600)
  #expect(owner.expire() == [.approval(approval)])
  #expect(!owner.isApproved(approval))
  #expect(owner.take(approval) == nil)
}

@Test func staleViewAndCrossAuthorityHandlesCannotClearOrReplaceFocus() {
  let (first, _) = authority("forced-collision"), (second, _) = authority("forced-collision")
  let staleView = ready(first)
  let live = ready(second)
  let request = second.admit(live, snapshot: "live")!
  #expect(second.currentReview()?.request == request)
  let approval = second.approve(request)!
  #expect(!second.setFocused(staleView))
  #expect(!second.clearFocused(staleView))
  #expect(second.isApproved(approval))
  #expect(second.setFocused(nil))
  #expect(!second.isApproved(approval))
}

@Test func backwardsClockFailsClosedPermanently() {
  let (owner, clock) = authority(), session = ready(owner)
  let request = owner.admit(session, snapshot: "approved")!
  #expect(owner.currentReview()?.request == request)
  let approval = owner.approve(request)!
  #expect(owner.take(approval) == "approved")
  clock.advance(seconds: 10)
  #expect(owner.isApproved(approval))
  clock.rewind(seconds: 1)
  #expect(owner.expire() == [.approval(approval)])
  #expect(!owner.isApproved(approval))
  #expect(owner.register(generation: "later") == nil)
  owner.setForeground(true)
  #expect(!owner.resumeReview())
}
