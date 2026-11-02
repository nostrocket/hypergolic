import Foundation

protocol NativeApprovalClock: Sendable { func now() -> Duration }
protocol NativeApprovalEntropy: Sendable { func namespace() -> String }

private struct ContinuousApprovalClock: NativeApprovalClock {
  private let origin = ContinuousClock.now
  func now() -> Duration { origin.duration(to: .now) }
}

private struct UUIDApprovalEntropy: NativeApprovalEntropy {
  func namespace() -> String { UUID().uuidString.lowercased() }
}

fileprivate final class NativeApprovalOwnerIdentity: Hashable, @unchecked Sendable {
  static func == (lhs: NativeApprovalOwnerIdentity, rhs: NativeApprovalOwnerIdentity) -> Bool { lhs === rhs }
  func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }
}

struct NativeApprovalSessionHandle: Hashable, Sendable {
  fileprivate let owner: NativeApprovalOwnerIdentity
  fileprivate let value: String
}
struct NativeApprovalRequestHandle: Hashable, Sendable {
  fileprivate let owner: NativeApprovalOwnerIdentity
  fileprivate let value: String
}
struct NativeApprovalHandle: Hashable, Sendable {
  fileprivate let owner: NativeApprovalOwnerIdentity
  fileprivate let value: String
}

enum NativeApprovalExpiration: Equatable, Sendable {
  case request(NativeApprovalRequestHandle)
  case approval(NativeApprovalHandle)
}

/// Pure native lifetime authority. The host admits only an already validated, exact serialized snapshot.
/// No bridge, signer, network, UIKit or WebKit object is stored here.
final class NativeApprovalAuthority: @unchecked Sendable {
  static let maximumSnapshotBytes = 2 * 1024 * 1024
  static let maximumSessions = 64
  static let maximumPendingPerSession = 4
  static let maximumRequests = 16
  static let receiptLifetime: Duration = .seconds(600)

  struct Review: Equatable, Sendable {
    let request: NativeApprovalRequestHandle
    let snapshot: String
  }

  private struct Session: Sendable { let generation: String }
  private enum RequestStatus: Sendable {
    case pending
    case approved(handle: NativeApprovalHandle, taken: Bool)
  }
  private struct Request: Sendable {
    let session: NativeApprovalSessionHandle
    let snapshot: String
    let order: UInt64
    let expires: Duration
    var executionPaused = false
    var status: RequestStatus
    var isPending: Bool { if case .pending = status { true } else { false } }
  }
  private struct State: Sendable {
    var sessions: [NativeApprovalSessionHandle: Session] = [:]
    var generationIndex: [String: NativeApprovalSessionHandle] = [:]
    var requests: [NativeApprovalRequestHandle: Request] = [:]
    var focused: NativeApprovalSessionHandle?
    var current: NativeApprovalRequestHandle?
    var foreground = false
    var paused = false
    var nextHandle: UInt64 = 0
    var nextOrder: UInt64 = 0
    var lastNow: Duration?
    var clockFailed = false
  }

  private let lock = NSLock()
  private var value = State()
  private let clock: any NativeApprovalClock
  private let namespace: String
  private let ownerIdentity = NativeApprovalOwnerIdentity()

  init() {
    clock = ContinuousApprovalClock()
    namespace = UUIDApprovalEntropy().namespace()
  }

  /// Owning tests only. Production construction owns both its monotonic clock and random namespace.
  init(testingClock: any NativeApprovalClock, testingEntropy: any NativeApprovalEntropy) {
    clock = testingClock
    namespace = testingEntropy.namespace()
  }

  func register(generation: String) -> NativeApprovalSessionHandle? {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, generation.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
        $0.generationIndex[generation] == nil, $0.sessions.count < Self.maximumSessions,
        let token = nextToken(&$0) else { return nil }
      let handle = NativeApprovalSessionHandle(owner: ownerIdentity, value: token)
      $0.sessions[handle] = Session(generation: generation)
      $0.generationIndex[generation] = handle
      return handle
    }
  }

  @discardableResult func teardown(_ session: NativeApprovalSessionHandle) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, let removed = $0.sessions.removeValue(forKey: session) else { return false }
      $0.generationIndex.removeValue(forKey: removed.generation)
      removeRequests(session: session, state: &$0)
      if $0.focused == session { $0.focused = nil; $0.current = nil }
      return true
    }
  }

  func setForeground(_ foreground: Bool) {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed else { return }
      $0.foreground = foreground
      guard !foreground else { return }
      $0.paused = true
      $0.current = nil
      removeApproved(state: &$0)
    }
  }

  @discardableResult func setFocused(_ session: NativeApprovalSessionHandle?) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed else { return false }
      if let session, $0.sessions[session] == nil { return false }
      guard $0.focused != session else { return true }
      if let previous = $0.focused { removeApproved(session: previous, state: &$0) }
      $0.focused = session
      $0.current = nil
      return true
    }
  }

  /// Use for delayed native view deactivation; a stale view cannot clear a replacement focus.
  @discardableResult func clearFocused(_ session: NativeApprovalSessionHandle) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, $0.focused == session else { return false }
      removeApproved(session: session, state: &$0)
      $0.focused = nil
      $0.current = nil
      return true
    }
  }

  func admit(_ session: NativeApprovalSessionHandle, snapshot: String) -> NativeApprovalRequestHandle? {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, $0.sessions[session] != nil, !snapshot.isEmpty,
        snapshot.utf8.count <= Self.maximumSnapshotBytes,
        $0.requests.count < Self.maximumRequests,
        $0.requests.values.filter({ $0.session == session }).count < Self.maximumPendingPerSession,
        $0.nextOrder < UInt64.max, let token = nextToken(&$0) else { return nil }
      $0.nextOrder += 1
      let handle = NativeApprovalRequestHandle(owner: ownerIdentity, value: token)
      // String is a value-semantic immutable snapshot; no caller-owned object is retained.
      $0.requests[handle] = Request(session: session, snapshot: String(snapshot), order: $0.nextOrder,
        expires: $0.lastNow! + Self.receiptLifetime, status: .pending)
      return handle
    }
  }

  func currentReview() -> Review? {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, let candidate = currentReviewRequest(&$0) else { return nil }
      return Review(request: candidate.0, snapshot: candidate.1.snapshot)
    }
  }

  func approve(_ request: NativeApprovalRequestHandle) -> NativeApprovalHandle? {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, let candidate = currentReviewRequest(&$0), candidate.0 == request,
        var item = $0.requests[request], let token = nextToken(&$0) else { return nil }
      let approval = NativeApprovalHandle(owner: ownerIdentity, value: token)
      item.status = .approved(handle: approval, taken: false)
      $0.requests[request] = item
      $0.current = nil
      return approval
    }
  }

  func isApproved(_ approval: NativeApprovalHandle) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, let (_, request) = request(approval: approval, state: $0) else { return false }
      return approvalEligible(request, state: $0)
    }
  }

  /// Returns the immutable snapshot once while leaving the approval live for later authority checks.
  func take(_ approval: NativeApprovalHandle) -> String? {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, let (handle, request) = request(approval: approval, state: $0),
        approvalEligible(request, state: $0),
        case .approved(let exact, false) = request.status, exact == approval else { return nil }
      var updated = request
      updated.status = .approved(handle: approval, taken: true)
      $0.requests[handle] = updated
      return request.snapshot
    }
  }

  /// Final successful or failed operation cleanup after the last authority recheck.
  @discardableResult func finish(_ approval: NativeApprovalHandle) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, let (handle, request) = request(approval: approval, state: $0),
        approvalEligible(request, state: $0) else { return false }
      $0.requests.removeValue(forKey: handle)
      return true
    }
  }

  /// Native-only pause, under the same authority lock as review and approval effects.
  func pauseExecution(_ request: NativeApprovalRequestHandle, paused: Bool) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, $0.foreground, !$0.paused, var row = $0.requests[request],
        $0.focused == row.session, $0.sessions[row.session] != nil, row.executionPaused != paused else { return false }
      row.executionPaused = paused; $0.requests[request] = row; return true
    }
  }
  func signingLifetime(_ request: NativeApprovalRequestHandle) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, let row = $0.requests[request] else { return false }
      return $0.foreground && !$0.paused && $0.focused == row.session && $0.sessions[row.session] != nil
    }
  }
  func contains(_ request: NativeApprovalRequestHandle) -> Bool {
    withState {
      _ = prune(&$0)
      return !$0.clockFailed && $0.requests[request] != nil
    }
  }

  @discardableResult func cancel(_ request: NativeApprovalRequestHandle) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, $0.requests.removeValue(forKey: request) != nil else { return false }
      if $0.current == request { $0.current = nil }
      return true
    }
  }

  @discardableResult func cancel(_ approval: NativeApprovalHandle) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, let (handle, _) = request(approval: approval, state: $0) else { return false }
      $0.requests.removeValue(forKey: handle)
      return true
    }
  }

  @discardableResult func dismiss(_ request: NativeApprovalRequestHandle) -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, $0.foreground, !$0.paused, $0.current == request,
        let item = $0.requests[request], item.session == $0.focused, item.isPending else { return false }
      $0.requests.removeValue(forKey: request)
      $0.current = nil
      $0.paused = true
      return true
    }
  }

  @discardableResult func resumeReview() -> Bool {
    withState {
      _ = prune(&$0)
      guard !$0.clockFailed, $0.foreground, let focused = $0.focused, $0.sessions[focused] != nil else { return false }
      $0.paused = false
      return true
    }
  }

  /// Timer entry point. Other calls also prune before making an authority decision.
  func expire() -> [NativeApprovalExpiration] { withState { prune(&$0) } }

  private func withState<T>(_ operation: (inout State) -> T) -> T {
    lock.withLock { operation(&value) }
  }

  private func nextToken(_ state: inout State) -> String? {
    guard state.nextHandle < UInt64.max else { return nil }
    state.nextHandle += 1
    return "\(namespace)-\(state.nextHandle)"
  }

  private func prune(_ state: inout State) -> [NativeApprovalExpiration] {
    guard !state.clockFailed else { return [] }
    let now = clock.now()
    if let last = state.lastNow, now < last {
      state.clockFailed = true
      let revoked = state.requests.map { handle, request in
        switch request.status {
        case .pending: return NativeApprovalExpiration.request(handle)
        case .approved(let approval, _): return NativeApprovalExpiration.approval(approval)
        }
      }
      state.sessions.removeAll(); state.generationIndex.removeAll(); state.requests.removeAll()
      state.focused = nil; state.current = nil; state.paused = true
      return revoked
    }
    state.lastNow = now
    var expired: [NativeApprovalExpiration] = []
    for (handle, request) in state.requests where now >= request.expires {
      switch request.status {
      case .pending: expired.append(.request(handle))
      case .approved(let approval, _): expired.append(.approval(approval))
      }
      state.requests.removeValue(forKey: handle)
      if state.current == handle { state.current = nil }
    }
    return expired
  }

  private func currentReviewRequest(_ state: inout State) -> (NativeApprovalRequestHandle, Request)? {
    guard state.foreground, !state.paused, let focused = state.focused,
      state.sessions[focused] != nil, approvedRequest(state) == nil else { return nil }
    if let current = state.current, let request = state.requests[current],
      request.session == focused, request.isPending, !request.executionPaused { return (current, request) }
    let next = state.requests.lazy.filter { $0.value.session == focused && $0.value.isPending && !$0.value.executionPaused }
      .min { $0.value.order < $1.value.order }
    guard let next else { state.current = nil; return nil }
    state.current = next.key
    return (next.key, next.value)
  }

  private func approvedRequest(_ state: State) -> NativeApprovalRequestHandle? {
    state.requests.first { if case .approved = $0.value.status { true } else { false } }?.key
  }

  private func request(approval: NativeApprovalHandle, state: State) -> (NativeApprovalRequestHandle, Request)? {
    state.requests.first {
      if case .approved(let handle, _) = $0.value.status { handle == approval } else { false }
    }
  }

  private func approvalEligible(_ request: Request, state: State) -> Bool {
    !request.executionPaused && state.foreground && !state.paused && state.focused == request.session && state.sessions[request.session] != nil
  }

  private func removeRequests(session: NativeApprovalSessionHandle, state: inout State) {
    let handles = state.requests.compactMap { $0.value.session == session ? $0.key : nil }
    for handle in handles { state.requests.removeValue(forKey: handle) }
    if let current = state.current, handles.contains(current) { state.current = nil }
  }

  private func removeApproved(session: NativeApprovalSessionHandle? = nil, state: inout State) {
    let handles = state.requests.compactMap { handle, request -> NativeApprovalRequestHandle? in
      guard session == nil || request.session == session else { return nil }
      if case .approved = request.status { return handle }
      return nil
    }
    for handle in handles { state.requests.removeValue(forKey: handle) }
  }
}
