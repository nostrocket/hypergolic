import XCTest
import Foundation
import Synchronization
@testable import SignerProbe

private let assertions = Mutex(0)
private func check(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) { assertions.withLock { $0 += 1 }; XCTAssertTrue(value, file: file, line: line) }
private func scalar(_ byte: UInt8) -> Data { var data = Data(count: 32); data[31] = byte; return data }
private struct Fixture: @unchecked Sendable {
  let relay: String, changed: String, peer: String, user: String, bunker: String, control: String, nonce: String, anchor: Data
  init() throws {
    let path = Bundle.main.url(forResource: "Nip46Fixture", withExtension: "json")!
    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: String]
    relay = object["relayURL"]!; changed = object["changedRelayURL"]!; peer = object["peerPubkey"]!; user = object["userPubkey"]!
    bunker = object["bunkerURL"]!; control = object["controlURL"]!; nonce = object["nonce"]!
    anchor = Data(base64Encoded: object["anchor"]!)!
  }
  func fault(_ name: String, method: String = "sign_event", relays: [String]? = nil) async throws {
    var object: [String: Any] = ["fault": name, "method": method, "relays": relays ?? [relay]]
    if name == "null-relays" { object = ["fault": "none", "relays": NSNull(), "stringRelays": true] }
    var request = URLRequest(url: URL(string: control)!); request.httpMethod = "POST"; request.setValue(nonce, forHTTPHeaderField: "x-fixture-control")
    request.httpBody = try JSONSerialization.data(withJSONObject: object)
    let (_, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw NativeVaultFailure.signerUnavailable }
  }
  func completeLatestAuth(clientPubkey: String, decision: String = "approve", fault: String? = nil, method: String = "sign_event") async throws {
    var request = URLRequest(url: URL(string: control.replacingOccurrences(of: "/control", with: "/status"))!)
    request.setValue(nonce, forHTTPHeaderField: "x-fixture-control")
    let (bytes, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200,
      let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let requests = object["requests"] as? [[String: Any]],
      let latest = requests.last(where: { $0["clientPubkey"] as? String == clientPubkey && $0["method"] as? String == method }), let id = latest["id"] as? String else { throw NativeVaultFailure.signerUnavailable }
    var controlBody: [String: Any] = ["completeAuth": ["clientPubkey": clientPubkey, "id": id, "decision": decision]]
    if let fault { controlBody["fault"] = fault; controlBody["method"] = method }
    request = URLRequest(url: URL(string: control)!); request.httpMethod = "POST"; request.setValue(nonce, forHTTPHeaderField: "x-fixture-control")
    request.httpBody = try JSONSerialization.data(withJSONObject: controlBody)
    let (_, completion) = try await URLSession.shared.data(for: request)
    guard (completion as? HTTPURLResponse)?.statusCode == 200 else { throw NativeVaultFailure.signerUnavailable }
  }
  func client(_ key: NativeVaultKey, handoff: NativeNip46Handoff? = nil) -> NativeNip46Client {
    NativeNip46Client(key: key, peer: peer, handoff: handoff, exchange: { relay, subscription, event, deadline, control, validate in
      try await withCheckedThrowingContinuation { reply in
        do { _ = try NativeSignerRelayTransport.exchangeForProof(relay, subscription: subscription, event: event, address: "127.0.0.1", anchorDER: self.anchor,
          deadline: deadline, control: control, validate: validate) { reply.resume(with: $0) } }
        catch { reply.resume(throwing: error) }
      }
    })
  }
  func event(content: String = "Native WSS exact event 🛰️") throws -> ExactSignerEvent {
    try ExactSignerEvent(json: "{\"pubkey\":\"\(user)\",\"created_at\":\(UInt64(Date().timeIntervalSince1970)),\"kind\":1,\"tags\":[[\"r\",\"wss://publication.example.org\"]],\"content\":\(ExactSignerEvent.quote(content))}", expectedPubkey: user)
  }
  func connect(_ client: NativeNip46Client) async throws {
    var parsed = try NativeBunkerConnection(bunker); defer { parsed.clear() }
    let bound = try await client.handshake(token: parsed.token, relays: parsed.relays, deadline: .now.advanced(by: .seconds(10)), current: { true }, dispatch: { $0() })
    check(bound.pubkey == user); check(bound.relays == [relay])
  }
}
final class SignerCoreTests: XCTestCase, @unchecked Sendable {
  override func tearDown() { print("NIP46_NATIVE_ASSERTIONS=\(assertions.withLock { let total = $0; $0 = 0; return total })"); super.tearDown() }
  func testNativeRealWSSHandshakeAndExactSignature() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    try await fixture.fault("none"); try await fixture.connect(client)
    let event = try fixture.event(), state = NativeNip46DispatchState()
    let signed = try await client.sign(event, relays: [fixture.relay], deadline: .now.advanced(by: .seconds(10)), current: { true }, dispatch: { $0() }, state: state)
    check(state.possible); check(try NativeNostrSignedEvent(json: signed, peer: fixture.user).event == event)
    let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("nip46-signature.json")
    try Data(signed.utf8).write(to: file)
  }
  func testNativeRealWSSRejectsAlteredAndUnverifiableSignatures() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    try await fixture.fault("none"); try await fixture.connect(client)
    for fault in ["wrong-user", "changed-event", "invalid-inner-id", "invalid-inner-signature", "bad-mac", "wrong-recipient", "invalid-outer-id", "invalid-outer-signature"] {
      try await fixture.fault(fault)
      do { _ = try await client.sign(fixture.event(), relays: [fixture.relay], deadline: .now.advanced(by: .seconds(5)), current: { true }, dispatch: { $0() }, state: NativeNip46DispatchState()); check(false) }
      catch let failure as NativeVaultFailure { check(failure == .signerResponseInvalid) }
    }
  }
  func testExplicitRefusalAndAuthURLNeverReturnSignature() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    try await fixture.fault("none"); try await fixture.connect(client)
    for (fault, expected) in [("refusal", NativeVaultFailure.signerRejected), ("auth-url", .signerUnsupported)] {
      try await fixture.fault(fault)
      do { _ = try await client.sign(fixture.event(), relays: [fixture.relay], deadline: .now.advanced(by: .seconds(5)), current: { true }, dispatch: { $0() }, state: NativeNip46DispatchState()); check(false) }
      catch let failure as NativeVaultFailure { check(failure == expected) }
      if fault == "auth-url" { try await fixture.completeLatestAuth(clientPubkey: key.publicKey(), decision: "refuse") }
    }
  }
  func testLostOrUncorrelatedReplyRemainsUncertainWithoutRetry() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    try await fixture.fault("none"); try await fixture.connect(client)
    for fault in ["close-after-send", "wrong-id", "wrong-peer", "no-response"] {
      try await fixture.fault(fault, relays: [fixture.relay, fixture.changed])
      let state = NativeNip46DispatchState()
      do { _ = try await client.sign(fixture.event(), relays: [fixture.relay, fixture.changed], deadline: .now.advanced(by: .seconds(2)), current: { true }, dispatch: { $0() }, state: state); check(false) }
      catch let failure as NativeVaultFailure { check(failure == .signerUncertain); check(state.possible) }
    }
  }
  func testSafePreRPCFailoverUsesSecondRelayWithoutRepeatingDispatch() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    var failed = URLComponents(string: fixture.relay)!; failed.path = "/unavailable"
    let relays = [failed.string!, fixture.relay]; try await fixture.fault("none", relays: relays)
    var bunker = try NativeBunkerConnection(fixture.bunker); defer { bunker.clear() }
    let bound = try await client.handshake(token: bunker.token, relays: relays, deadline: .now.advanced(by: .seconds(10)), current: { true }, dispatch: { $0() })
    check(bound.pubkey == fixture.user && bound.relays == relays)
    let state = NativeNip46DispatchState(), event = try fixture.event()
    let signed = try await client.sign(event, relays: relays, deadline: .now.advanced(by: .seconds(10)), current: { true }, dispatch: { $0() }, state: state)
    check(state.possible); check(try NativeNostrSignedEvent(json: signed, peer: fixture.user).event == event)
  }
  func testSavedRelayChangeStopsBeforeSignDispatchAndNullKeepsSet() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    try await fixture.fault("none"); try await fixture.connect(client)
    try await fixture.fault("none", relays: [fixture.changed]); let state = NativeNip46DispatchState()
    do { _ = try await client.sign(fixture.event(), relays: [fixture.relay], deadline: .now.advanced(by: .seconds(5)), current: { true }, dispatch: { $0() }, state: state); check(false) }
    catch let failure as NativeVaultFailure { check(failure == .signerRelaysChanged); check(!state.possible) }
    try await fixture.fault("null-relays")
    let signed = try await client.sign(fixture.event(), relays: [fixture.relay], deadline: .now.advanced(by: .seconds(5)), current: { true }, dispatch: { $0() }, state: state)
    check(try NativeNostrSignedEvent(json: signed, peer: fixture.user).event.pubkey == fixture.user)
  }
  func testPreDispatchCancellationAndOversizeNeverSign() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    try await fixture.fault("none"); try await fixture.connect(client)
    let state = NativeNip46DispatchState()
    do { _ = try await client.sign(fixture.event(), relays: [fixture.relay], deadline: .now.advanced(by: .seconds(5)), current: { false }, dispatch: { $0() }, state: state); check(false) }
    catch { check(!state.possible) }
    do { _ = try NativeNip46Protocol.request(id: UUID().uuidString.lowercased(), method: "sign_event", params: [String(repeating: "\\", count: 2_102_000)]); check(false) }
    catch let failure as NativeVaultFailure { check(failure == .signerUnsupported); check(!state.possible) }
  }
  func testSameIDAuthReplyAndNativeResumeAreBothRequiredWithoutResend() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let clientPubkey = try key.publicKey()
    try await fixture.fault("none"); try await fixture.connect(fixture.client(key)); try await fixture.fault("auth-url")
    let resumes = Mutex(0)
    let ticket = NativeNip46Handoff(binding: .signing(kind: "approval", token: UUID().uuidString.lowercased(), vaultID: "native-test-vault-01", revision: 1, eventID: "native-exact"), deadline: .now.advanced(by: .seconds(5)), current: { true },
      pause: { paused in if !paused { resumes.withLock { $0 += 1 } }; return true }, show: { ticket, _ in
        Task {
          check(ticket.arm()); check(ticket.requestResume()); check(ticket.publicState == "pending"); check(!ticket.permitsExecution)
          do { try await fixture.completeLatestAuth(clientPubkey: clientPubkey) } catch { check(false); ticket.cancel() }
        }
      })
    defer { ticket.cancel() }
    let event = try fixture.event(), signed = try await fixture.client(key, handoff: ticket).sign(event, relays: [fixture.relay], deadline: ticket.deadline, current: { true }, dispatch: { $0() }, state: NativeNip46DispatchState())
    check(try NativeNostrSignedEvent(json: signed, peer: fixture.user).event == event); check(ticket.publicState == "resumed"); check(resumes.withLock { $0 == 1 })
  }
  func testInitialConnectAuthContinuesSameRPCBeforeFollowingHandshakeStages() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let clientPubkey = try key.publicKey()
    try await fixture.fault("auth-url", method: "connect")
    let ticket = NativeNip46Handoff(binding: .preparation(vaultID: "native-test-vault-01", revision: 1, attemptID: "connection-attempt", refresh: false), deadline: .now.advanced(by: .seconds(5)), current: { true }, show: { ticket, _ in
      Task { check(ticket.arm()); check(ticket.requestResume()); do { try await fixture.completeLatestAuth(clientPubkey: clientPubkey, method: "connect") } catch { check(false); ticket.cancel() } }
    }); defer { ticket.cancel() }
    var bunker = try NativeBunkerConnection(fixture.bunker); defer { bunker.clear() }
    let bound = try await fixture.client(key, handoff: ticket).handshake(token: bunker.token, relays: [fixture.relay], deadline: ticket.deadline, current: { true }, dispatch: { $0() })
    check(bound.pubkey == fixture.user && bound.relays == [fixture.relay]); check(ticket.publicState == "resumed")
  }
  func testAuthChangedFinalRefusalAndCancellationNeverReleaseNativeEffects() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let clientPubkey = try key.publicKey()
    try await fixture.fault("none"); try await fixture.connect(fixture.client(key))
    for (mode, expected) in [("changed-event", NativeVaultFailure.signerResponseInvalid), ("refuse", .signerRejected), ("cancel", .signerUncertain)] {
      try await fixture.fault("auth-url")
      let alive = Mutex(true), resumes = Mutex(0)
      let ticket = NativeNip46Handoff(binding: .signing(kind: "approval", token: UUID().uuidString.lowercased(), vaultID: "native-test-vault-01", revision: 1, eventID: "native-exact"), deadline: .now.advanced(by: .seconds(4)), current: { alive.withLock { $0 } },
        pause: { paused in if !paused { resumes.withLock { $0 += 1 } }; return true }, cancel: { alive.withLock { $0 = false } }, show: { ticket, _ in
          Task {
            check(ticket.arm()); check(ticket.requestResume()); check(!ticket.permitsExecution)
            if mode == "cancel" { ticket.cancel() }
            do { try await fixture.completeLatestAuth(clientPubkey: clientPubkey, decision: mode == "changed-event" ? "approve" : "refuse", fault: mode == "changed-event" ? mode : nil) }
            catch { check(false); ticket.cancel() }
          }
        })
      do { _ = try await fixture.client(key, handoff: ticket).sign(fixture.event(), relays: [fixture.relay], deadline: ticket.deadline, current: { alive.withLock { $0 } }, dispatch: { $0() }, state: NativeNip46DispatchState()); check(false) }
      catch let failure as NativeVaultFailure { check(failure == expected) }
      ticket.cancel(); check(resumes.withLock { $0 == 0 }); check(ticket.publicState == nil)
    }
  }
  func testExplicitRefreshKeepsUnchangedSetAndVerifiesChangedAccount() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    try await fixture.fault("none"); try await fixture.connect(client)
    let unchanged = try await client.refresh(pubkey: fixture.user, relays: [fixture.relay], deadline: .now.advanced(by: .seconds(5)), current: { true }, dispatch: { $0() })
    check(unchanged == nil)
    try await fixture.fault("none", relays: [fixture.changed])
    let changed = try await client.refresh(pubkey: fixture.user, relays: [fixture.relay], deadline: .now.advanced(by: .seconds(5)), current: { true }, dispatch: { $0() })
    check(changed == [fixture.changed])
    try await fixture.fault("wrong-public-key", method: "get_public_key", relays: [fixture.changed])
    do { _ = try await client.refresh(pubkey: fixture.user, relays: [fixture.relay], deadline: .now.advanced(by: .seconds(5)), current: { true }, dispatch: { $0() }); check(false) }
    catch let failure as NativeVaultFailure { check(failure == .signerResponseInvalid) }
  }
  func testRefreshCancellationExpiryAndSixOpenBudgetDenyBeforeEffect() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    let emits = Mutex(0)
    for (alive, deadline) in [(false, ContinuousClock.now.advanced(by: .seconds(5))), (true, ContinuousClock.now.advanced(by: .seconds(-1)))] {
      do { _ = try await client.refresh(pubkey: fixture.user, relays: [fixture.relay], deadline: deadline, current: { alive }, dispatch: { emit in emits.withLock { $0 += 1 }; emit() }); check(false) }
      catch let failure as NativeVaultFailure { check(failure == .signerExpired) }
    }
    check(emits.withLock { $0 == 0 })
    let budget = NativeSignerRelayTransport.Budget(maximumOpens: 6), deadline = ContinuousClock.now.advanced(by: .seconds(5))
    for _ in 0..<6 { try budget.accept(deadline: deadline, opening: true) }
    do { try budget.accept(deadline: deadline, opening: true); check(false) } catch { check(!budget.isValid(deadline: deadline)) }
  }
  func testUnicodeNormalizationCannotAlterReviewedContentOrTagCells() throws {
    let key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let pubkey = try key.publicKey()
    let composed = "\u{00e9}", decomposed = "e\u{0301}"
    check(composed == decomposed); check(!composed.utf8.elementsEqual(decomposed.utf8))
    func event(_ content: String, _ tag: String) throws -> ExactSignerEvent {
      try ExactSignerEvent(json: "{\"pubkey\":\"\(pubkey)\",\"created_at\":1,\"kind\":1,\"tags\":[[\"t\",\(ExactSignerEvent.quote(tag))]],\"content\":\(ExactSignerEvent.quote(content))}", expectedPubkey: pubkey)
    }
    let reviewed = try event(composed, composed), alteredContent = try event(decomposed, composed), alteredTag = try event(composed, decomposed)
    check(reviewed != alteredContent); check(reviewed != alteredTag)
    check(reviewed.digest != alteredContent.digest); check(reviewed.digest != alteredTag.digest)
    for altered in [alteredContent, alteredTag] {
      let signed = try NativeNostrSignedEvent(json: key.sign(altered), peer: pubkey)
      do { _ = try signed.matches(reviewed); check(false) } catch NativeVaultFailure.signerResponseInvalid { check(true) }
    }
    let escaped = try ExactSignerEvent(json: reviewed.unsignedJSON.replacingOccurrences(of: composed, with: "\\u00e9"), expectedPubkey: pubkey)
    check(escaped == reviewed); check(try NativeNostrSignedEvent(json: key.sign(escaped), peer: pubkey).event == reviewed)
    check(escaped.digest == reviewed.digest)
  }
  func testPinnedConnectAcknowledgementAcceptsAckOrExactSuppliedSecret() {
    var token = Data("disposable-native-handshake-token".utf8); defer { token.resetBytes(in: 0..<token.count) }
    check(NativeNip46Protocol.acceptsConnectAcknowledgement(.string("ack"), token: token))
    check(NativeNip46Protocol.acceptsConnectAcknowledgement(.string("disposable-native-handshake-token"), token: token))
    check(!NativeNip46Protocol.acceptsConnectAcknowledgement(.string("disposable-native-handshake-tokeX"), token: token))
    check(!NativeNip46Protocol.acceptsConnectAcknowledgement(.string("wrong"), token: token))
    check(!NativeNip46Protocol.acceptsConnectAcknowledgement(.null, token: token))
    check(!NativeNip46Protocol.acceptsConnectAcknowledgement(.string(""), token: Data()))
  }
  func testControlledSingleTLSWriteWithValidReplyAndMalformedSuffix() async throws {
    let fixture = try Fixture(), key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let client = fixture.client(key)
    try await fixture.fault("none"); try await fixture.connect(client)
    for fault in ["valid-plus-invalid-suffix", "valid-plus-close-trailing"] {
      try await fixture.fault(fault)
      do { _ = try await client.sign(fixture.event(), relays: [fixture.relay], deadline: .now.advanced(by: .seconds(5)), current: { true }, dispatch: { $0() }, state: NativeNip46DispatchState()); check(false) }
      catch let failure as NativeVaultFailure { check(failure == .signerResponseInvalid) }
    }
  }
  func testOneBudgetCountsBothDirectionsAndPoisonsAcrossRPCs() throws {
    let budget = NativeSignerRelayTransport.Budget(), deadline = ContinuousClock.now.advanced(by: .seconds(10))
    for _ in 0..<9 { try budget.accept(deadline: deadline, wire: 1024, frames: 3, texts: 3, opening: true) }
    check(budget.isValid(deadline: deadline))
    do { try budget.accept(deadline: deadline, opening: true); check(false) } catch { check(true) }
    check(!budget.isValid(deadline: deadline))
    do { try budget.accept(deadline: deadline); check(false) } catch { check(true) }
    let wire = NativeSignerRelayTransport.Budget()
    try wire.accept(deadline: deadline, wire: 16 * 1024 * 1024); try wire.accept(deadline: deadline, wire: 16 * 1024 * 1024)
    do { try wire.accept(deadline: deadline, wire: 1); check(false) } catch { check(true) }
    let text = NativeSignerRelayTransport.Budget(); try text.accept(deadline: deadline, texts: 32)
    do { try text.accept(deadline: deadline, texts: 1); check(false) } catch { check(true) }
    let clock = NativeSignerRelayTransport.Budget(); try clock.accept(deadline: deadline)
    do { try clock.accept(deadline: deadline.advanced(by: .seconds(1))); check(false) } catch { check(true) }
    check(!clock.isValid(deadline: deadline))
  }
  func testFragmentAndControlFramesCountBeforeAnyBatchDelivery() throws {
    let decoder = PublishedRelayWebSocketFrames(), first = Data([0x01, 2, 65, 66]), continuation = Data([0x80, 2, 67, 68])
    check(decoder.feed(first).isEmpty); check(decoder.completedFrames == 1)
    check(decoder.feed(continuation) == [.text("ABCD")]); check(decoder.completedFrames == 2)
    let flood = PublishedRelayWebSocketFrames(), deadline = ContinuousClock.now.advanced(by: .seconds(10))
    var batch = Data([0x81, 6]); batch.append(contentsOf: "result".utf8)
    for _ in 0..<64 { batch.append(contentsOf: [0x89, 0]) }
    let budget = NativeSignerRelayTransport.Budget(); var deliveries = 0
    do { deliveries = try NativeSignerRelayTransport.decodeBatch(batch, decoder: flood, budget: budget, deadline: deadline).count; check(false) }
    catch { check(true) }
    check(flood.completedFrames == 65 && deliveries == 0); check(!budget.isValid(deadline: deadline))
  }
  func testMatchingPrefixCannotBypassInvalidSuffixOrUnconsumedCloseBytes() throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    let text = Data([0x81, 6]) + Data("result".utf8)
    for suffix in [Data([0x81, 0x80, 0, 0, 0, 0]), Data([0x88, 0]) + text] {
      let decoder = PublishedRelayWebSocketFrames(), budget = NativeSignerRelayTransport.Budget(); var delivered = 0
      do { let batch = try NativeSignerRelayTransport.decodeBatch(text + suffix, decoder: decoder, budget: budget, deadline: deadline)
        delivered = batch.count; check(false)
      } catch NativeSignerRelayTransport.Failure.invalidResponse { check(true) }
      check(delivered == 0); check(!budget.isValid(deadline: deadline)); check(decoder.consumedInput < text.count + suffix.count)
    }
    let normal = PublishedRelayWebSocketFrames(), budget = NativeSignerRelayTransport.Budget()
    check(try NativeSignerRelayTransport.decodeBatch(text, decoder: normal, budget: budget, deadline: deadline) == [.text("result")])
    check(normal.consumedInput == text.count)
  }
  func testRemoteProfileSupportsLargeFramesWithoutChangingOrdinaryLimit() {
    let size = 70_000, bytes = Data(repeating: 65, count: size)
    var wire = Data([0x81, 127]); for shift in stride(from: 56, through: 0, by: -8) { wire.append(UInt8((UInt64(size) >> shift) & 255)) }; wire.append(bytes)
    let normal = PublishedRelayWebSocketFrames(), remote = PublishedRelayWebSocketFrames(maximumBytes: NativeSignerRelayTransport.maximumTextBytes + 14)
    var normalEvents: [PublishedRelayWebSocketFrames.Event] = [], remoteEvents: [PublishedRelayWebSocketFrames.Event] = []
    for offset in stride(from: 0, to: wire.count, by: 8192) {
      let chunk = wire.subdata(in: offset..<min(offset + 8192, wire.count)); normalEvents += normal.feed(chunk); remoteEvents += remote.feed(chunk)
    }
    check(normalEvents.contains { if case .error = $0 { return true }; return false })
    check(remoteEvents == [.text(String(repeating: "A", count: size))]); check(remote.completedFrames == 1)
  }
  func testRemoteCandidateDeadlineReplayAndCancelConsumedHandle() async throws {
    let fixture = try Fixture(), pool = NativeVaultRemoteCandidates(), key = try NativeVaultKey(secret: scalar(1)), revoked = Mutex(0)
    let raw = try pool.prepare(pubkey: fixture.user, peer: fixture.peer, relays: [fixture.relay], key: key, vaultID: "native-test-vault-0001", revision: 1, epoch: 1, expires: .now.advanced(by: .milliseconds(30)))
    let object = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: String], handle = object["handle"]!
    let candidate = try pool.take(handle: handle, vaultID: "native-test-vault-0001", revision: 1, epoch: 1)
    pool.cancel(handle, beforeDestroy: { revoked.withLock { $0 += 1 } }); check(revoked.withLock { $0 == 1 })
    do { _ = try candidate.key.publicKey(); check(false) } catch { check(true) }
    do { _ = try pool.take(handle: handle, vaultID: "native-test-vault-0001", revision: 1, epoch: 1); check(false) } catch { check(true) }
    let pending = try NativeVaultKey(secret: scalar(1)); _ = try pool.prepare(pubkey: fixture.user, peer: fixture.peer, relays: [fixture.relay], key: pending, vaultID: "native-test-vault-0001", revision: 1, epoch: 1, expires: .now.advanced(by: .milliseconds(20)))
    try await Task.sleep(for: .milliseconds(60))
    do { _ = try pending.publicKey(); check(false) } catch { check(true) }
  }
}
