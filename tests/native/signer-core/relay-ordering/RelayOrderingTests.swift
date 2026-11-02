import Foundation
import Synchronization

private func scalar(_ byte: UInt8) -> Data { var value = Data(count: 32); value[31] = byte; return value }
private let saved = ["wss://relay.example.org/saved"]
private let changed = ["wss://relay.example.org/changed"]

// In-memory exchange double only. Keys, NIP-01 signatures, NIP-44 encryption,
// RPC correlation, actual Client and Handoff validation remain production code.
private final class EncryptedExchange: @unchecked Sendable {
  let peer: NativeVaultKey, user: NativeVaultKey
  let proposed: [String], resumeBeforeFinal: Bool
  let cancelAfterSignedReply: Bool
  let signedReplyBeforeCancel = Mutex<(executionPermitted: Bool, pauses: [Bool])?>(nil)
  let ticket = Mutex<NativeNip46Handoff?>(nil)
  let methods = Mutex<[String]>([])
  let pauseTransitions = Mutex<[Bool]>([])
  let resumeAccepted = Mutex<[Bool]>([])
  init(proposed: [String], resumeBeforeFinal: Bool, cancelAfterSignedReply: Bool = false) throws {
    peer = try NativeVaultKey(secret: scalar(7)); user = try NativeVaultKey(secret: scalar(9))
    self.proposed = proposed; self.resumeBeforeFinal = resumeBeforeFinal
    self.cancelAfterSignedReply = cancelAfterSignedReply
  }
  deinit { peer.destroy(); user.destroy() }
  func makeTicket(refresh: Bool) -> NativeNip46Handoff {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    let value = NativeNip46Handoff(binding: refresh ? .preparation(vaultID: "ordering-host", revision: 1, attemptID: "refresh", refresh: true)
      : .signing(kind: "approval", token: "owning-host", vaultID: "ordering-host", revision: 1, eventID: "exact"),
      deadline: deadline, current: { true }, pause: { [self] paused in pauseTransitions.withLock { $0.append(paused) }; return true },
      show: { [self] value, _ in
        precondition(value.arm())
        if resumeBeforeFinal { resumeAccepted.withLock { $0.append(value.requestResume()) } }
      })
    ticket.withLock { $0 = value }
    return value
  }
  func exchange(relay: String, subscription: String, wire: String, deadline: ContinuousClock.Instant,
    control: NativeSignerRelayTransport.Control, validate: @escaping @Sendable (String) throws -> Bool) async throws -> String {
    try control.dispatch { }
    let frame = try JSONSerialization.jsonObject(with: Data(wire.utf8)) as! [Any]
    let outerData = try JSONSerialization.data(withJSONObject: frame[1])
    let raw = String(decoding: outerData, as: UTF8.self)
    let author = (frame[1] as! [String: Any])["pubkey"] as! String
    let verified = try NativeNostrSignedEvent(json: raw, peer: author)
    let plaintext = try peer.decryptAuthenticated(peer: author, payload: Data(verified.event.content.utf8))
    let request = try JSONSerialization.jsonObject(with: plaintext) as! [String: Any]
    let id = request["id"] as! String, method = request["method"] as! String
    methods.withLock { $0.append(method) }
    let sub = (try JSONSerialization.jsonObject(with: Data(subscription.utf8)) as! [Any])[1] as! String
    func envelope(_ response: [String: Any]) throws -> String {
      let bytes = try JSONSerialization.data(withJSONObject: response)
      let encrypted = try NativeNip46Protocol.outer(plaintext: bytes, peer: author, key: peer,
                                                   now: UInt64(Date().timeIntervalSince1970))
      return "[\"EVENT\",\(ExactSignerEvent.quote(sub)),\(encrypted)]"
    }
    let response: Any
    switch method {
    case "get_public_key": response = try user.publicKey()
    case "connect": response = "ack"
    case "switch_relays":
      if !cancelAfterSignedReply {
        let challenge = try envelope(["id": id, "result": "auth_url", "error": "https://auth.example.org/fixture"])
        let challenged = try validate(challenge)
        precondition(!challenged)
      }
      response = proposed
    case "sign_event":
      if cancelAfterSignedReply {
        let challenge = try envelope(["id": id, "result": "auth_url", "error": "https://auth.example.org/fixture"])
        let challenged = try validate(challenge)
        precondition(!challenged)
      }
      let params = request["params"] as! [String]
      let event = try ExactSignerEvent(json: params[0], expectedPubkey: user.publicKey())
      response = try user.sign(event)
    default: throw NativeVaultFailure.signerUnsupported
    }
    let final = try envelope(["id": id, "result": response])
    do {
      let accepted = try validate(final)
      precondition(accepted)
      if method == "sign_event", cancelAfterSignedReply, let value = ticket.withLock({ $0 }) {
        // The production validator has authenticated the exact final signature.
        // Snapshot the still-held continuation, then cancel before any Resume.
        let permitted = value.permitsExecution
        let pauses = pauseTransitions.withLock { $0 }
        signedReplyBeforeCancel.withLock { $0 = (permitted, pauses) }
        value.cancel()
      }
      if method == "switch_relays", !resumeBeforeFinal, !cancelAfterSignedReply, let value = ticket.withLock({ $0 }) {
        resumeAccepted.withLock { $0.append(value.requestResume()) }
      }
      return final
    } catch {
      // A user can request Resume after a rejected reply too. It must not restore authority.
      if method == "switch_relays", !resumeBeforeFinal, !cancelAfterSignedReply, let value = ticket.withLock({ $0 }) {
        resumeAccepted.withLock { $0.append(value.requestResume()) }
      }
      throw error
    }
  }
}

@main private enum RelayOrderingTests {
  static func main() async throws {
    var failures: [String] = [], rows: [[String: Any]] = [], assertions = 0
    func check(_ value: Bool, _ label: String) { assertions += 1; if !value { failures.append(label) } }
    for isChanged in [true, false] {
      for early in [true, false] {
        let exchange = try EncryptedExchange(proposed: isChanged ? changed : saved, resumeBeforeFinal: early)
        let ticket = exchange.makeTicket(refresh: false)
        let key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }
        let client = NativeNip46Client(key: key, peer: try exchange.peer.publicKey(), handoff: ticket, exchange: exchange.exchange)
        let user = try exchange.user.publicKey()
        let event = try ExactSignerEvent(json: "{\"pubkey\":\(ExactSignerEvent.quote(user)),\"created_at\":1791979200,\"kind\":1,\"tags\":[],\"content\":\"Exact ordering regression\"}", expectedPubkey: user)
        let dispatch = NativeNip46DispatchState()
        var failure: NativeVaultFailure?, returned = false
        do {
          let signed = try await client.sign(event, relays: saved, deadline: ticket.deadline, current: { true }, dispatch: { $0() }, state: dispatch)
          returned = try NativeNostrSignedEvent(json: signed, peer: user).event == event
        } catch let error as NativeVaultFailure { failure = error }
        // Snapshot BEFORE harness cancellation; cancellation cannot mask a transient release.
        let transitions = exchange.pauseTransitions.withLock { $0 }
        let permitted = ticket.permitsExecution, methods = exchange.methods.withLock { $0 }
        let label = "changed=\(isChanged),resumeBeforeFinal=\(early)"
        check(exchange.resumeAccepted.withLock { $0 } == [true], label + ": native Resume accepted once")
        if isChanged {
          check(failure == .signerRelaysChanged && !returned, label + ": changed list denies")
          check(transitions == [true], label + ": no pause(false)")
          check(!permitted, label + ": execution remains held")
          check(!dispatch.possible && !methods.contains("sign_event"), label + ": zero sign dispatch")
        } else {
          check(failure == nil && returned, label + ": exact signature succeeds")
          check(transitions == [true, false] && permitted, label + ": validated same list releases")
          check(dispatch.possible && methods.filter({ $0 == "sign_event" }).count == 1, label + ": one sign dispatch")
        }
        rows.append(["changed": isChanged, "resumeBeforeFinal": early, "pauseTransitionsBeforeCancel": transitions,
                     "permitsExecutionBeforeCancel": permitted, "methods": methods, "returned": returned,
                     "failure": failure?.rawValue ?? "none"])
        ticket.cancel()
        exchange.ticket.withLock { $0 = nil }
      }
    }
    // Explicit refresh is allowed to propose a changed set after the same authenticated handoff.
    let refresh = try EncryptedExchange(proposed: changed, resumeBeforeFinal: true)
    let ticket = refresh.makeTicket(refresh: true), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }
    let client = NativeNip46Client(key: key, peer: try refresh.peer.publicKey(), handoff: ticket, exchange: refresh.exchange)
    let proposal = try await client.refresh(pubkey: refresh.user.publicKey(), relays: saved, deadline: ticket.deadline, current: { true }, dispatch: { $0() })
    check(proposal == changed, "Explicit refresh retains changed proposal")
    check(refresh.pauseTransitions.withLock { $0 } == [true, false] && ticket.permitsExecution, "Refresh authenticated handoff releases")
    check(!refresh.methods.withLock { $0 }.contains("sign_event"), "Refresh never signs")
    ticket.cancel()
    refresh.ticket.withLock { $0 = nil }
    let connection = try EncryptedExchange(proposed: changed, resumeBeforeFinal: true)
    let connecting = connection.makeTicket(refresh: true), connectingKey = try NativeVaultKey(secret: scalar(1))
    defer { connectingKey.destroy() }
    let connectingClient = NativeNip46Client(key: connectingKey, peer: try connection.peer.publicKey(), handoff: connecting, exchange: connection.exchange)
    let bound = try await connectingClient.handshake(token: Data("new-host-token".utf8), relays: saved,
      deadline: connecting.deadline, current: { true }, dispatch: { $0() })
    let connectingUser = try connection.user.publicKey()
    check(bound.relays == changed && bound.pubkey == connectingUser, "Handshake retains changed proposal")
    check(connection.pauseTransitions.withLock { $0 } == [true, false] && connecting.permitsExecution, "Handshake authenticated handoff releases")
    check(connection.methods.withLock { $0 } == ["connect", "get_public_key", "switch_relays"], "Handshake never signs")
    connecting.cancel()
    connection.ticket.withLock { $0 = nil }
    // A genuine signed response can arrive before native Resume. Cancellation
    // after validation must still withhold it and preserve possible-send uncertainty.
    let cancelled = try EncryptedExchange(proposed: saved, resumeBeforeFinal: false, cancelAfterSignedReply: true)
    let cancelledTicket = cancelled.makeTicket(refresh: false)
    let cancelledKey = try NativeVaultKey(secret: scalar(1)); defer { cancelledKey.destroy() }
    let cancelledUser = try cancelled.user.publicKey()
    let cancelledClient = NativeNip46Client(key: cancelledKey, peer: try cancelled.peer.publicKey(),
      handoff: cancelledTicket, exchange: cancelled.exchange)
    let cancelledEvent = try ExactSignerEvent(json: "{\"pubkey\":\(ExactSignerEvent.quote(cancelledUser)),\"created_at\":1791979200,\"kind\":1,\"tags\":[],\"content\":\"Authenticated reply withheld until native Resume\"}", expectedPubkey: cancelledUser)
    let cancelledDispatch = NativeNip46DispatchState()
    var cancelledFailure: NativeVaultFailure?, cancelledResult: String?
    do {
      cancelledResult = try await cancelledClient.sign(cancelledEvent, relays: saved,
        deadline: cancelledTicket.deadline, current: { true }, dispatch: { $0() }, state: cancelledDispatch)
    } catch let error as NativeVaultFailure { cancelledFailure = error }
    let beforeCancel = cancelled.signedReplyBeforeCancel.withLock { $0 }
    let cancelledMethods = cancelled.methods.withLock { $0 }
    check(beforeCancel != nil, "Cancel-after-final: real signed reply validated before cancellation")
    check(beforeCancel?.executionPermitted == false && beforeCancel?.pauses == [true],
      "Cancel-after-final: validated reply alone never releases execution")
    check(cancelled.resumeAccepted.withLock { $0.isEmpty }, "Cancel-after-final: no native Resume requested")
    check(cancelledDispatch.possible, "Cancel-after-final: actual possible signing dispatch retained")
    check(cancelledResult == nil && cancelledFailure == .signerUncertain,
      "Cancel-after-final: no signed result escapes; uncertainty is preserved")
    check(cancelledMethods == ["get_public_key", "switch_relays", "sign_event"],
      "Cancel-after-final: exact preflights and one signing request, no retry")
    check(cancelled.pauseTransitions.withLock { $0 } == [true], "Cancel-after-final: no pause(false)")
    check(!cancelledTicket.permitsExecution && cancelledTicket.publicState == nil,
      "Cancel-after-final: cancelled continuation stays revoked")
    rows.append(["case": "sign-event-valid-reply-then-cancel-before-resume",
      "authenticatedSignedReplyBeforeCancel": beforeCancel != nil,
      "permitsExecutionBeforeCancel": beforeCancel?.executionPermitted ?? true,
      "pauseTransitionsBeforeCancel": beforeCancel?.pauses ?? [],
      "pauseTransitionsAfterCancel": cancelled.pauseTransitions.withLock { $0 },
      "possibleSigningDispatch": cancelledDispatch.possible, "methods": cancelledMethods,
      "returned": cancelledResult != nil, "failure": cancelledFailure?.rawValue ?? "none"])
    cancelledTicket.cancel()
    cancelled.ticket.withLock { $0 = nil }
    let output: [String: Any] = ["passed": failures.isEmpty, "assertions": assertions, "failures": failures, "cases": rows,
      "scope": "macOS host actual Client/Handoff/C NIP44/NIP01; in-memory exchange and pause callbacks, no network/UI/lower registry claim"]
    print(String(decoding: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), as: UTF8.self))
    if !failures.isEmpty { exit(1) }
  }
}
