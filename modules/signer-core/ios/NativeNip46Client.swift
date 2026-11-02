import Foundation
import Synchronization
#if canImport(HypergolicNappletHost)
import HypergolicNappletHost
#endif

/// A native operation owns one client key and has one in-flight correlated request.
final class NativeNip46DispatchState: Sendable {
  private let value = Mutex(false)
  func markPossible() { value.withLock { $0 = true } }
  var possible: Bool { value.withLock { $0 } }
}
final class NativeNip46Client: @unchecked Sendable {
  struct BoundResult: Sendable { let pubkey: String; let relays: [String] }
  typealias Exchange = @Sendable (String, String, String, ContinuousClock.Instant, NativeSignerRelayTransport.Control, @escaping @Sendable (String) throws -> Bool) async throws -> String
  private let key: NativeVaultKey
  private let peer: String
  private let exchange: Exchange
  private let flight = Mutex(false)
  private let handoff: NativeNip46Handoff?
  init(key: NativeVaultKey, peer: String, handoff: NativeNip46Handoff? = nil, exchange: @escaping Exchange = nativeNip46Exchange) {
    self.key = key; self.peer = peer; self.handoff = handoff; self.exchange = exchange
  }
  func handshake(token: Data, relays: [String], deadline: ContinuousClock.Instant,
    current: @escaping @Sendable () -> Bool, dispatch: @escaping @Sendable (@Sendable () -> Void) throws -> Void) async throws -> BoundResult {
    let budget = NativeSignerRelayTransport.Budget()
    guard let secret = String(data: token, encoding: .utf8) else { throw NativeVaultFailure.invalidSignerConnection }
    let connected = try await call("connect", params: [peer, secret, "sign_event", "{\"name\":\"Hypergolic\"}"], relays: relays, deadline: deadline, current: current, dispatch: dispatch, budget: budget)
    guard NativeNip46Protocol.acceptsConnectAcknowledgement(connected, token: token) else { throw NativeVaultFailure.signerResponseInvalid }
    let pubkey = try NativeNip46Protocol.publicKey(await call("get_public_key", params: [], relays: relays, deadline: deadline, current: current, dispatch: dispatch, budget: budget))
    let switched = try NativeNip46Protocol.switchedRelays(await call("switch_relays", params: [], relays: relays, deadline: deadline, current: current, dispatch: dispatch, budget: budget), saved: relays)
    return BoundResult(pubkey: pubkey, relays: switched)
  }
  /// Explicit refresh has no signing request and never changes the saved capability itself.
  func refresh(pubkey: String, relays: [String], deadline: ContinuousClock.Instant,
    current: @escaping @Sendable () -> Bool, dispatch: @escaping @Sendable (@Sendable () -> Void) throws -> Void) async throws -> [String]? {
    let budget = NativeSignerRelayTransport.Budget(maximumOpens: 6)
    let proposed = try NativeNip46Protocol.switchedRelays(await call("switch_relays", params: [], relays: relays,
      deadline: deadline, current: current, dispatch: dispatch, budget: budget), saved: relays)
    guard Set(proposed) != Set(relays) else { return nil }
    let reported = try NativeNip46Protocol.publicKey(await call("get_public_key", params: [], relays: proposed,
      deadline: deadline, current: current, dispatch: dispatch, budget: budget, expectedPubkey: pubkey))
    guard reported == pubkey else { throw NativeVaultFailure.signerResponseInvalid }
    return proposed
  }
  func sign(_ event: ExactSignerEvent, relays: [String], deadline: ContinuousClock.Instant,
    current: @escaping @Sendable () -> Bool, dispatch: @escaping @Sendable (@Sendable () -> Void) throws -> Void,
    state: NativeNip46DispatchState) async throws -> String {
    let budget = NativeSignerRelayTransport.Budget()
    var preflight = try NativeNip46Protocol.request(id: UUID().uuidString.lowercased(), method: "sign_event", params: [event.unsignedJSON])
    preflight.resetBytes(in: 0..<preflight.count)
    let reported = try NativeNip46Protocol.publicKey(await call("get_public_key", params: [], relays: relays, deadline: deadline, current: current, dispatch: dispatch, budget: budget, expectedPubkey: event.pubkey))
    guard reported == event.pubkey else { throw NativeVaultFailure.signerResponseInvalid }
    let refreshed = try NativeNip46Protocol.switchedRelays(await call("switch_relays", params: [], relays: relays, deadline: deadline, current: current, dispatch: dispatch, budget: budget, expectedRelays: relays), saved: relays)
    guard Set(refreshed) == Set(relays) else { throw NativeVaultFailure.signerRelaysChanged }
    let result = try await call("sign_event", params: [event.unsignedJSON], relays: relays, deadline: deadline, current: current, dispatch: dispatch, budget: budget, state: state, reviewed: event)
    guard case .string(let signed) = result else { throw NativeVaultFailure.signerResponseInvalid }
    return try NativeNostrSignedEvent(json: signed, peer: event.pubkey).matches(event)
  }
  private func call(_ method: String, params: [String], relays: [String], deadline: ContinuousClock.Instant,
    current: @escaping @Sendable () -> Bool, dispatch: @escaping @Sendable (@Sendable () -> Void) throws -> Void,
    budget: NativeSignerRelayTransport.Budget, state: NativeNip46DispatchState? = nil, reviewed: ExactSignerEvent? = nil, expectedPubkey: String? = nil, expectedRelays: [String]? = nil) async throws -> SignerJSONValue {
    guard flight.withLock({ value in guard !value else { return false }; value = true; return true }) else { throw NativeVaultFailure.busy }
    defer { flight.withLock { $0 = false } }
    guard current(), !Task.isCancelled, ContinuousClock.now < deadline else { throw NativeVaultFailure.signerExpired }
    guard (1...3).contains(relays.count), Set(relays).count == relays.count else { throw NativeVaultFailure.signerUnavailable }
    let id = UUID().uuidString.lowercased(), subscriptionID = UUID().uuidString.lowercased(), client = try key.publicKey()
    var plaintext = try NativeNip46Protocol.request(id: id, method: method, params: params)
    defer { plaintext.resetBytes(in: 0..<plaintext.count) }
    let outer = try NativeNip46Protocol.outer(plaintext: plaintext, peer: peer, key: key, now: UInt64(Date().timeIntervalSince1970))
    let subscription = "[\"REQ\",\(ExactSignerEvent.quote(subscriptionID)),{\"kinds\":[24133],\"authors\":[\(ExactSignerEvent.quote(peer))],\"#p\":[\(ExactSignerEvent.quote(client))],\"since\":\(UInt64(max(0, Date().timeIntervalSince1970 - 30)))}]"
    let result = Mutex<SignerJSONValue?>(nil)
    let validate: @Sendable (String) throws -> Bool = { [peer, key, handoff] envelope in
      do {
      var parser = SignerJSONParser(envelope, maximumBytes: NativeNip46Protocol.maximumEnvelope + 256)
      guard case .array(let values) = try parser.parse(), case .string(let kind) = values.first else { throw NativeVaultFailure.signerResponseInvalid }
      if ["OK", "EOSE", "NOTICE"].contains(kind) { return false }
      guard kind == "EVENT", values.count == 3, case .string(let returnedSubscription) = values[1], returnedSubscription == subscriptionID,
        case .object(let event) = values[2] else { throw NativeVaultFailure.signerResponseInvalid }
      guard case .string(let author) = event["pubkey"], author == peer else { return false }
      let raw = try NativeNip46Protocol.encode(values[2])
      guard let response = try NativeNip46Protocol.response(outer: raw, peer: peer, key: key, id: id, now: UInt64(Date().timeIntervalSince1970), authURL: handoff.map { ticket in { url in try ticket.challenge(requestID: id, url: url) } }) else { return false }
      // Validate method semantics before retaining the single bounded public response during Safari.
      switch method {
      case "connect": guard NativeNip46Protocol.acceptsConnectAcknowledgement(response, token: Data(params[1].utf8)) else { throw NativeVaultFailure.signerResponseInvalid }
      case "get_public_key": let reported = try NativeNip46Protocol.publicKey(response); guard expectedPubkey == nil || reported == expectedPubkey else { throw NativeVaultFailure.signerResponseInvalid }
      case "switch_relays":
        let switched = try NativeNip46Protocol.switchedRelays(response, saved: relays)
        if let expectedRelays, Set(switched) != Set(expectedRelays) { throw NativeVaultFailure.signerRelaysChanged }
      case "sign_event": guard let reviewed, case .string(let signed) = response else { throw NativeVaultFailure.signerResponseInvalid }; _ = try NativeNostrSignedEvent(json: signed, peer: reviewed.pubkey).matches(reviewed)
      default: throw NativeVaultFailure.signerUnsupported
      }
      if handoff?.permitsExecution == false { try handoff?.authenticated(requestID: id) }
      result.withLock { $0 = response }; return true
      } catch let failure as NativeVaultFailure { throw failure }
      catch { throw NativeVaultFailure.signerResponseInvalid }
    }
    let control = NativeSignerRelayTransport.Control(current: { current() && ContinuousClock.now < deadline }, budget: budget, dispatch: { [handoff] emit in
      guard current(), ContinuousClock.now < deadline, handoff?.permitsExecution != false else { throw NativeVaultFailure.signerExpired }; try dispatch { state?.markPossible(); emit() }
    })
    do {
      for (index, relay) in relays.enumerated() {
        do { _ = try await exchange(relay, subscription, "[\"EVENT\"," + outer + "]", deadline, control, validate); break }
        catch NativeSignerRelayTransport.Failure.unavailable where index + 1 < relays.count {
          // Only this transport status proves no RPC EVENT bytes could have been sent.
          guard current(), !Task.isCancelled, budget.isValid(deadline: deadline) else { throw NativeVaultFailure.signerExpired }
          continue
        }
      }
      guard current(), !Task.isCancelled, ContinuousClock.now < deadline, let response = result.withLock({ $0 }) else {
        throw state?.possible == true ? NativeVaultFailure.signerUncertain : .signerExpired
      }; try await handoff?.waitForResume(); return response
    } catch let failure as NativeVaultFailure {
      if failure == .signerExpired, state?.possible == true { throw NativeVaultFailure.signerUncertain }; throw failure
    }
    catch let failure as NativeSignerRelayTransport.Failure {
      if case .invalidResponse = failure { throw NativeVaultFailure.signerResponseInvalid }
      if state?.possible == true { throw NativeVaultFailure.signerUncertain }
      switch failure { case .invalidResponse: throw NativeVaultFailure.signerResponseInvalid
      case .expired, .cancelled: throw NativeVaultFailure.signerExpired
      default: throw NativeVaultFailure.signerUnavailable }
    } catch { throw state?.possible == true ? NativeVaultFailure.signerUncertain : .signerUnavailable }
  }
}
private final class NativeNip46ExchangeLifetime: Sendable {
  private struct State { var cancelled = false; var operation: NativeSignerRelayTransport.Operation? }
  private let value = Mutex(State())
  func attach(_ operation: NativeSignerRelayTransport.Operation) { value.withLock { if $0.cancelled { operation.cancel() } else { $0.operation = operation } } }
  func cancel() { value.withLock { $0.cancelled = true; $0.operation?.cancel(); $0.operation = nil } }
}
private func nativeNip46Exchange(relay: String, subscription: String, event: String, deadline: ContinuousClock.Instant,
  control: NativeSignerRelayTransport.Control, validate: @escaping @Sendable (String) throws -> Bool) async throws -> String {
  let lifetime = NativeNip46ExchangeLifetime()
  return try await withTaskCancellationHandler {
    try await withCheckedThrowingContinuation { reply in
      do { lifetime.attach(try NativeSignerRelayTransport.exchange(relay, subscription: subscription, event: event, deadline: deadline, control: control, validate: validate) { reply.resume(with: $0) }) }
      catch { reply.resume(throwing: error) }
    }
  } onCancel: { lifetime.cancel() }
}

/// Process-only continuation state. Owner and source closures never run under handoff locks.
final class NativeNip46Handoff: @unchecked Sendable {
  enum Binding: Equatable, Sendable {
    case signing(kind: String, token: String, vaultID: String, revision: UInt64, eventID: String)
    case preparation(vaultID: String, revision: UInt64, attemptID: String, refresh: Bool)
  }
  private enum Phase { case idle, pausing, challenged, pending, releasing, resumed, revoked }
  private struct State { var phase = Phase.idle; var requestID: String?; var authenticated = false; var resumeRequested = false }
  let binding: Binding
  let deadline: ContinuousClock.Instant
  private let state = Mutex(State())
  private let current: @Sendable () -> Bool
  private let pause: @Sendable (Bool) -> Bool
  private let cancelSource: @Sendable () -> Void
  private let show: @Sendable (NativeNip46Handoff, URL) -> Void
  init(binding: Binding, deadline: ContinuousClock.Instant, current: @escaping @Sendable () -> Bool,
    pause: @escaping @Sendable (Bool) -> Bool = { _ in true }, cancel: @escaping @Sendable () -> Void = {},
    show: @escaping @Sendable (NativeNip46Handoff, URL) -> Void) {
    self.binding = binding; self.deadline = deadline; self.current = current; self.pause = pause; cancelSource = cancel; self.show = show
  }
  private func live() -> Bool { current() && ContinuousClock.now < deadline }
  var canPresentAuthentication: Bool { guard live() else { return false }; return state.withLock { $0.phase == .challenged } && live() }
  var canRequestResume: Bool { guard live() else { return false }; return state.withLock { $0.phase == .pending && !$0.resumeRequested } && live() }
  var isActive: Bool { guard live() else { return false }; return state.withLock { $0.phase != .revoked } && live() }
  var permitsExecution: Bool { guard live() else { return false }; return state.withLock { $0.phase == .idle || $0.phase == .resumed } && live() }
  var publicState: String? {
    guard live() else { return nil }
    let value: String? = state.withLock { switch $0.phase { case .pausing, .challenged, .pending, .releasing: return "pending"; case .resumed: return "resumed"; default: return nil } }
    return live() ? value : nil
  }
  func challenge(requestID: String, url: String) throws {
    let destination: URL
    do { destination = try NativeSignerRelayPolicy.authenticationDestination(url) } catch { throw NativeVaultFailure.signerResponseInvalid }
    guard live(), state.withLock({ value in guard value.phase == .idle else { return false }; value.requestID = requestID; value.phase = .pausing; return true }) else { throw NativeVaultFailure.signerResponseInvalid }
    guard pause(true), live(), state.withLock({ value in guard value.phase == .pausing else { return false }; value.phase = .challenged; return true }) else {
      cancel(); throw NativeVaultFailure.signerExpired
    }
    show(self, destination)
  }
  /// Called only after native origin confirmation, never by a bridge method.
  func arm() -> Bool {
    guard live() else { return false }
    let armed = state.withLock { value in guard value.phase == .challenged else { return false }; value.phase = .pending; return true }
    return armed && live()
  }
  /// Native Resume and the authenticated original-ID method result are both required.
  func requestResume() -> Bool {
    guard live() else { cancel(); return false }
    let accepted = state.withLock { value in guard value.phase == .pending, !value.resumeRequested else { return false }; value.resumeRequested = true; return true }
    guard accepted else { return false }; return releaseIfReady()
  }
  func authenticated(requestID: String) throws {
    guard live() else { cancel(); throw NativeVaultFailure.signerExpired }
    let accepted = state.withLock { value in
      guard value.requestID == requestID, [.challenged, .pending].contains(value.phase), !value.authenticated else { return false }
      value.authenticated = true; return true
    }
    guard accepted, releaseIfReady() else { cancel(); throw NativeVaultFailure.signerExpired }
  }
  private func releaseIfReady() -> Bool {
    let ready = state.withLock { value in
      guard value.authenticated && value.resumeRequested && value.phase == .pending else { return false }
      value.phase = .releasing; return true
    }
    guard ready else { return isActive }
    // Owning source pause and final native epoch checks occur outside this lock.
    guard live(), pause(false), live(), state.withLock({ value in guard value.phase == .releasing else { return false }; value.phase = .resumed; return true }) else { cancel(); return false }
    return true
  }
  func waitForResume() async throws {
    while true {
      let phase = state.withLock { $0.phase }
      if phase == .idle || phase == .resumed { guard live(), !Task.isCancelled else { cancel(); throw NativeVaultFailure.signerExpired }; return }
      guard phase != .revoked, live(), !Task.isCancelled else { cancel(); throw NativeVaultFailure.signerExpired }
      do { try await Task.sleep(for: .milliseconds(25)) } catch { cancel(); throw NativeVaultFailure.signerExpired }
    }
  }
  func cancel() { state.withLock { $0.phase = .revoked }; cancelSource() }
}
final class NativeNip46HandoffRegistry: @unchecked Sendable {
  private let lock = NSLock(); private var ticket: NativeNip46Handoff?
  private func snapshot() -> NativeNip46Handoff? { lock.withLock { ticket } }
  func install(_ next: NativeNip46Handoff) { let old = lock.withLock { let old = ticket; ticket = next; return old }; old?.cancel() }
  func permitsPresentation(_ expected: NativeNip46Handoff, resuming: Bool = false) -> Bool {
    guard owns(expected), resuming ? expected.canRequestResume : expected.canPresentAuthentication else { return false }; return owns(expected)
  }
  func owns(_ expected: NativeNip46Handoff) -> Bool { lock.withLock { ticket === expected } }
  func cancelAll() { let old = lock.withLock { let old = ticket; ticket = nil; return old }; old?.cancel() }
  func cancelSigning(kind: String, token: String) {
    let old = lock.withLock { () -> NativeNip46Handoff? in
      guard let row = ticket, case .signing(let expectedKind, let expectedToken, _, _, _) = row.binding,
        expectedKind == kind, expectedToken == token else { return nil }; ticket = nil; return row
    }; old?.cancel()
  }
  func signingState(kind: String, token: String) -> String? {
    guard let row = snapshot(), case .signing(let expectedKind, let expectedToken, _, _, _) = row.binding,
      expectedKind == kind, expectedToken == token else { return nil }
    let value = row.publicState; return owns(row) ? value : nil
  }
  func preparationState(vaultID: String, revision: UInt64, attemptID: String) -> String? {
    guard let row = snapshot(), case .preparation(let expectedID, let expectedRevision, let expectedAttempt, _) = row.binding,
      expectedID == vaultID, expectedRevision == revision, expectedAttempt == attemptID else { return nil }
    let value = row.publicState; return owns(row) ? value : nil
  }
}
