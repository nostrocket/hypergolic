import CryptoKit
import Foundation

@main
struct PublishedRelayWebSocketQueryProof {
  static func main() throws {
    try urlAndRequestProof()
    try coalescedUpgradeProof()
    try boundedEnvelopeDeliveryProof()
    try structuralRelayEnvelopeProof()
    print("iOS relay WSS query URL, framing, bounds, and envelope proofs passed")
  }

  private static func urlAndRequestProof() throws {
    let allowed = try PublishedRelayWebSocketQuery.Request("wss://relay.example.org/nostr")
    try check(allowed.host == "relay.example.org" && allowed.port == 443 && allowed.target == "/nostr", "valid relay URL")
    let original = try PublishedRelayWebSocketQuery.Request("wss://relay.example.org/a/../nostr")
    try check(original.target == "/a/../nostr", "ordinary accepted path preserved")
    try check(NativeSignerRelayPolicy.normalized("wss://relay.example.org/a/../nostr") == "wss://relay.example.org/nostr", "saved signer path normalized")
    let nonce = Data(0..<16)
    let wire = try allowed.upgrade(nonce: nonce)
    let text = String(decoding: wire, as: UTF8.self)
    try check(text.contains("GET /nostr HTTP/1.1\r\n"), "request path")
    try check(text.contains("Host: relay.example.org\r\n"), "request authority")
    try check(text.contains("Sec-WebSocket-Key: \(nonce.base64EncodedString())\r\n"), "nonce header")
    try check(text.hasSuffix("\r\n\r\n") && !text.contains("Sec-WebSocket-Extensions:"), "strict upgrade request")
    for rejected in [
      "wss://127.0.0.1/", "wss://relay.example.org/?q=1", "wss://relay.example.org/?",
      "wss://relay.example.org/#fragment", "wss://relay.example.org/#",
      "wss://user@relay.example.org/", "wss://relay.localdomain/", "wss://relay.example.123/",
      "wss://relay.example.org/%0d%0aInjected:yes", "wss://relay.example.org/%0a/../nostr", "wss://relay.example.org:0/",
    ] {
      do { _ = try PublishedRelayWebSocketQuery.Request(rejected); throw ProofFailure.failed("accepted URL: \(rejected)") }
      catch is ProofFailure { throw ProofFailure.failed("URL rejection assertion") }
      catch { /* expected */ }
    }
  }

  private static func coalescedUpgradeProof() throws {
    let nonce = Data(0..<16)
    var source = Data(nonce.base64EncodedString().utf8)
    source.append(contentsOf: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11".utf8)
    let accept = Data(Insecure.SHA1.hash(data: source)).base64EncodedString()
    let header = Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8)
    let firstFrame = Data([0x81, 0x02, 0x6f, 0x6b])
    var combined = header
    combined.append(firstFrame)
    var accumulator = PublishedRelayWebSocketQuery.HandshakeAccumulator()
    let result = try accumulator.append(combined)
    guard let result else { throw ProofFailure.failed("coalesced response split") }
    try PublishedRelayWebSocketHandshake.validate(result.headers, nonce: nonce)
    try check(result.prefetchedFrames == firstFrame, "coalesced WebSocket frame retained")
    let parser = PublishedRelayWebSocketFrames()
    try check(parser.feed(result.prefetchedFrames) == [.text("ok")], "coalesced frame decodes")
    do { _ = try accumulator.append(Data([0x00])); throw ProofFailure.failed("second upgrade chunk accepted") }
    catch is ProofFailure { throw ProofFailure.failed("second upgrade chunk assertion") }
    catch { /* expected */ }

    var oversized = PublishedRelayWebSocketQuery.HandshakeAccumulator()
    do {
      _ = try oversized.append(Data(repeating: 65, count: PublishedRelayWebSocketHandshake.maxHeaderBytes))
      throw ProofFailure.failed("unterminated oversized handshake accepted")
    } catch is ProofFailure { throw ProofFailure.failed("oversized handshake assertion") }
    catch { /* expected */ }
  }

  private static func boundedEnvelopeDeliveryProof() throws {
    var collector = PublishedRelayWebSocketQuery.TextCollector()
    let complete = try collector.accept([
      ("event-envelope", .event), ("notice-envelope", .other), ("eose-envelope", .eose),
    ])
    try check(complete && collector.envelopes == ["event-envelope", "notice-envelope", "eose-envelope"],
              "all validated text envelopes delivered through EOSE")
    do {
      _ = try collector.accept([("late-envelope", .other)])
      throw ProofFailure.failed("text after EOSE accepted")
    } catch is ProofFailure { throw ProofFailure.failed("post-EOSE assertion") }
    catch { /* expected */ }

    var eventLimit = PublishedRelayWebSocketQuery.TextCollector()
    let tooManyEvents = (0...PublishedRelayWebSocketQuery.maxEvents).map { ("event-\($0)", PublishedRelayWebSocketQuery.TextKind.event) }
    do { _ = try eventLimit.accept(tooManyEvents); throw ProofFailure.failed("33 EVENT texts accepted") }
    catch is ProofFailure { throw ProofFailure.failed("event cap assertion") }
    catch { /* expected */ }

    var textLimit = PublishedRelayWebSocketQuery.TextCollector()
    let tooManyTexts = (0...PublishedRelayWebSocketQuery.maxTextMessages).map { ("other-\($0)", PublishedRelayWebSocketQuery.TextKind.other) }
    do { _ = try textLimit.accept(tooManyTexts); throw ProofFailure.failed("65 text envelopes accepted") }
    catch is ProofFailure { throw ProofFailure.failed("text cap assertion") }
    catch { /* expected */ }
  }

  private static func structuralRelayEnvelopeProof() throws {
    let sid = "query-123"
    let event: [String: Any] = [
      "id": String(repeating: "a", count: 64), "pubkey": String(repeating: "b", count: 64),
      "created_at": 1_700_000_000, "kind": 1, "tags": [["t", "test"]],
      "content": "hello", "sig": String(repeating: "c", count: 128),
    ]
    let eventEnvelope = try jsonText(["EVENT", sid, event])
    try check(PublishedRelayEnvelope.classify(eventEnvelope, subscriptionId: sid) == .event, "valid EVENT classified")
    try check(PublishedRelayEnvelope.classify(eventEnvelope, subscriptionId: "other") == .invalid, "wrong EVENT subscription rejected")
    try check(PublishedRelayEnvelope.classify(try jsonText(["EOSE", sid]), subscriptionId: sid) == .eose,
              "exact EOSE subscription classified")
    try check(PublishedRelayEnvelope.classify(try jsonText(["EOSE", sid, "extra"]), subscriptionId: sid) == .invalid,
              "malformed EOSE rejected")
    try check(PublishedRelayEnvelope.classify(try jsonText(["NOTICE", String(repeating: "n", count: 256)]), subscriptionId: sid) == .other,
              "256-byte NOTICE accepted")
    try check(PublishedRelayEnvelope.classify(try jsonText(["NOTICE", String(repeating: "n", count: 257)]), subscriptionId: sid) == .invalid,
              "oversized NOTICE rejected")
    for challenge in ["", "rotated", String(repeating: "é", count: 256)] {
      try check(PublishedRelayEnvelope.classify(try jsonText(["AUTH", challenge]), subscriptionId: sid) == .other,
                "optional AUTH string announcement")
    }
    for malformedAuth: [Any] in [["AUTH"], ["AUTH", NSNull()], ["AUTH", ["challenge": "forged"]], ["AUTH", "challenge", "extra"]] {
      try check(PublishedRelayEnvelope.classify(try jsonText(malformedAuth), subscriptionId: sid) == .invalid,
                "malformed AUTH rejected")
    }
    try check(PublishedRelayEnvelope.classify(try jsonText(["AUTH", String(repeating: "é", count: PublishedRelayWebSocketFrames.maxBytes)]), subscriptionId: sid) == .invalid,
              "AUTH cannot exceed frame byte budget")
    try check(PublishedRelayEnvelope.classify(try jsonText(["CLOSED", sid, "closed"]), subscriptionId: sid) == .invalid,
              "CLOSED fails closed")
    try check(PublishedRelayEnvelope.classify(try jsonText(["EOSE", "prefix-\(sid)"]), subscriptionId: sid) == .invalid,
              "substring subscription id rejected")
    try check(PublishedRelayEnvelope.classify(try jsonText(["UNKNOWN", sid]), subscriptionId: sid) == .invalid,
              "unknown command rejected")
    var malformed = event
    malformed["kind"] = true
    try check(PublishedRelayEnvelope.classify(try jsonText(["EVENT", sid, malformed]), subscriptionId: sid) == .invalid,
              "boolean EVENT kind rejected")
  }

  private static func jsonText(_ object: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object)
    guard let text = String(data: data, encoding: .utf8) else { throw ProofFailure.failed("JSON fixture encoding") }
    return text
  }

  private static func check(_ value: Bool, _ label: String) throws {
    guard value else { throw ProofFailure.failed(label) }
  }

  enum ProofFailure: Error { case failed(String) }
}
