import Foundation

/// Native-only CEP-4 transport key. General MCP JSON stays opaque inside authenticated Nostr content.
final class NativeCvmEnvelope: @unchecked Sendable {
  static let maximumMessage = 32 * 1024, maximumEvent = 64 * 1024
  enum Failure: Error { case denied }
  private let lock = NSLock()
  private let key: NativeVaultKey
  private let peer: String
  private let current: @Sendable () throws -> Void
  private let outgoing: @Sendable (String, String) throws -> Void
  private var closed = false
  private var announced = false
  struct Decoded: Sendable {
    let message: String, eventId: String, references: [String], paymentInteraction: String?
  }
  struct Prepared: Sendable { let wire: String, innerEventId: String }
  init(peer: String, current: @escaping @Sendable () throws -> Void,
    outgoing: @escaping @Sendable (String, String) throws -> Void) throws {
    try current(); guard NativeVaultRecord.isPoint(peer) else { throw Failure.denied }
    self.peer = peer; self.current = current; self.outgoing = outgoing; key = try NativeVaultKey()
  }
  private func check() throws { guard !closed else { throw Failure.denied }; try current() }
  func clientPublicKey() throws -> String { try lock.withLock { try check(); return try key.publicKey() } }
  func encode(message: String, now: UInt64, ephemeralWrap: Bool, replyTo: String? = nil) throws -> String {
    try prepare(message: message, now: now, ephemeralWrap: ephemeralWrap, replyTo: replyTo).wire
  }
  func prepare(message: String, now: UInt64, ephemeralWrap: Bool, replyTo: String? = nil) throws -> Prepared {
    try lock.withLock {
      try check(); guard message.utf8.count <= Self.maximumMessage, now <= 9_007_199_254_740_991 else { throw Failure.denied }
      try outgoing(message, peer); try check()
      let publicKey = try key.publicKey()
      if let replyTo { guard NativeVaultRecord.isPubkey(replyTo) else { throw Failure.denied } }
      let inner = try Self.event(pubkey: publicKey, now: now, kind: 25910, recipient: peer, content: message, replyTo: replyTo, announce: !announced)
      var clear = Data(try key.sign(inner).utf8); defer { clear.resetBytes(in: 0..<clear.count) }
      let wrapping = try NativeVaultKey(); defer { wrapping.destroy() }
      var encrypted = try wrapping.encrypt(peer: peer, plaintext: clear); defer { encrypted.resetBytes(in: 0..<encrypted.count) }
      try check(); guard let content = String(data: encrypted, encoding: .utf8) else { throw Failure.denied }
      let wrappedTime = now - UInt64.random(in: 0...min(now, 172800))
      let outer = try Self.event(pubkey: wrapping.publicKey(), now: wrappedTime, kind: ephemeralWrap ? 21059 : 1059, recipient: peer, content: content)
      let result = try wrapping.sign(outer)
      guard result.utf8.count <= Self.maximumEvent else { throw Failure.denied }; try check(); announced = true
      return Prepared(wire: result, innerEventId: inner.digest.hex)
    }
  }
  func decode(signed: String, now: UInt64) throws -> Decoded {
    try lock.withLock {
      try check(); guard signed.utf8.count <= Self.maximumEvent, now <= 9_007_199_254_740_991 else { throw Failure.denied }
      var parser = SignerJSONParser(signed, maximumBytes: Self.maximumEvent)
      guard case .object(let fields) = try parser.parse(), case .string(let sender) = fields["pubkey"],
        NativeVaultRecord.isPoint(sender) else { throw Failure.denied }
      let outer = try NativeNostrSignedEvent(json: signed, peer: sender, maximumBytes: Self.maximumEvent).event
      let client = try key.publicKey()
      guard [1059,21059].contains(outer.kind), outer.createdAt <= now + 30,
        now <= outer.createdAt + 172800, Self.recipient(outer.tags, client) else { throw Failure.denied }
      try check()
      var clear = try key.decryptAuthenticated(peer: sender, payload: Data(outer.content.utf8)); defer { clear.resetBytes(in: 0..<clear.count) }
      guard clear.count <= Self.maximumEvent, let raw = String(data: clear, encoding: .utf8) else { throw Failure.denied }
      let inner = try NativeNostrSignedEvent(json: raw, peer: peer, maximumBytes: Self.maximumEvent).event
      guard inner.kind == 25910, inner.createdAt <= now + 30, now <= inner.createdAt + 120,
        inner.content.utf8.count <= Self.maximumMessage else { throw Failure.denied }
      let decoded = try Self.capture(inner, client: client); try check(); return decoded
    }
  }
  private static func event(pubkey: String, now: UInt64, kind: Int, recipient: String, content: String,
    replyTo: String? = nil, announce: Bool = false) throws -> ExactSignerEvent {
    var tags = [["p", recipient]]
    if let replyTo { tags.append(["e", replyTo]) }
    if announce { tags += [["support_encryption"], ["support_open_stream"], ["payment_interaction", "explicit_gating"]] }
    let rawTags = "[" + tags.map { "[" + $0.map(ExactSignerEvent.quote).joined(separator: ",") + "]" }.joined(separator: ",") + "]"
    let raw = "{\"pubkey\":\(ExactSignerEvent.quote(pubkey)),\"created_at\":\(now),\"kind\":\(kind),\"tags\":\(rawTags),\"content\":\(ExactSignerEvent.quote(content))}"
    return try ExactSignerEvent(json: raw, expectedPubkey: pubkey, maximumBytes: maximumEvent)
  }
  /// The trusted owning client still correlates these authenticated references to its sent inner IDs.
  private static func capture(_ inner: ExactSignerEvent, client: String) throws -> Decoded {
    var recipients = 0, references: [String] = [], mode: String?
    for tag in inner.tags {
      switch tag.first {
      case "p":
        guard tag.count >= 2, tag[1] == client, recipients == 0 else { throw Failure.denied }; recipients += 1
      case "e":
        guard tag.count >= 2, NativeVaultRecord.isPubkey(tag[1]), references.count < 16 else { throw Failure.denied }; references.append(tag[1])
      case "payment_interaction":
        guard mode == nil, tag.count == 2, ["explicit_gating", "transparent"].contains(tag[1]) else { throw Failure.denied }; mode = tag[1]
      default: break
      }
    }
    guard recipients > 0 || !references.isEmpty else { throw Failure.denied }
    return Decoded(message: inner.content, eventId: inner.digest.hex, references: references, paymentInteraction: mode)
  }
  private static func recipient(_ tags: [[String]], _ expected: String) -> Bool {
    let recipients = tags.filter { $0.first == "p" }
    return recipients.count == 1 && recipients[0].count >= 2 && recipients[0][1] == expected
  }
  func close() { lock.withLock { if !closed { closed = true; key.destroy() } } }
  deinit { close() }
}
