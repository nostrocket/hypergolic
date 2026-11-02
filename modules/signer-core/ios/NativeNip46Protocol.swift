import Foundation
import Darwin
#if canImport(CHypergolicSigner)
import CHypergolicSigner
#endif
#if canImport(HypergolicNappletHost)
import HypergolicNappletHost
#endif

/// Bounded exact NIP-01 validation is shared by authenticated RPC envelopes and final signatures.
struct NativeNostrSignedEvent {
  let event: ExactSignerEvent
  let json: String
  init(json: String, peer: String, maximumBytes: Int = ExactSignerEvent.maximumBytes + 256) throws {
    do {
    var parser = SignerJSONParser(json, maximumBytes: maximumBytes)
    guard case .object(var fields) = try parser.parse(), fields.count == 7,
      case .string(let id) = fields.removeValue(forKey: "id"), id.utf8.count == 64,
      case .string(let signature) = fields.removeValue(forKey: "sig"), signature.utf8.count == 128,
      let sigBytes = NativeVaultKey.hexBytes(signature), NativeVaultRecord.isPoint(peer), let pubBytes = NativeVaultKey.hexBytes(peer) else { throw NativeVaultFailure.signerResponseInvalid }
    let unsigned = try Self.unsigned(fields)
    let event = try ExactSignerEvent(json: unsigned, expectedPubkey: peer, maximumBytes: maximumBytes)
    guard event.digest.hex == id else { throw NativeVaultFailure.signerResponseInvalid }
    let verified = pubBytes.withUnsafeBytes { pub in sigBytes.withUnsafeBytes { sig in
      hypergolic_signer_verify_digest(pub.bindMemory(to: UInt8.self).baseAddress, event.digest, sig.bindMemory(to: UInt8.self).baseAddress)
    } }
    guard verified == 1 else { throw NativeVaultFailure.signerResponseInvalid }
    self.event = event; self.json = event.signedJSON(signature: Array(sigBytes))
    } catch let failure as NativeVaultFailure { throw failure }
    catch { throw NativeVaultFailure.signerResponseInvalid }
  }
  private static func unsigned(_ fields: [String: SignerJSONValue]) throws -> String {
    guard Set(fields.keys) == Set(["pubkey", "created_at", "kind", "tags", "content"]),
      case .string(let pubkey) = fields["pubkey"], case .integer(let createdAt) = fields["created_at"],
      case .integer(let kind) = fields["kind"], case .string(let content) = fields["content"], case .array(let rawTags) = fields["tags"] else { throw NativeVaultFailure.signerResponseInvalid }
    let tags = try rawTags.map { row -> String in
      guard case .array(let parts) = row else { throw NativeVaultFailure.signerResponseInvalid }
      return "[" + (try parts.map { part -> String in guard case .string(let value) = part else { throw NativeVaultFailure.signerResponseInvalid }; return ExactSignerEvent.quote(value) }).joined(separator: ",") + "]"
    }.joined(separator: ",")
    return "{\"pubkey\":\(ExactSignerEvent.quote(pubkey)),\"created_at\":\(createdAt),\"kind\":\(kind),\"tags\":[\(tags)],\"content\":\(ExactSignerEvent.quote(content))}"
  }
  func matches(_ reviewed: ExactSignerEvent) throws -> String {
    guard event == reviewed else { throw NativeVaultFailure.signerResponseInvalid }; return json
  }
}

struct NativeBunkerConnection {
  let peer: String
  let relays: [String]
  private(set) var token: Data
  init(_ raw: String) throws {
    guard raw.utf8.count <= 8192, raw.utf8.allSatisfy({ $0 >= 33 && $0 < 127 }),
      let parts = URLComponents(string: raw), parts.scheme == "bunker", parts.user == nil, parts.password == nil,
      parts.port == nil, parts.path.isEmpty, parts.fragment == nil, let peer = parts.host, NativeVaultRecord.isPoint(peer),
      let query = parts.queryItems, (1...4).contains(query.count), query.allSatisfy({ ["relay", "secret"].contains($0.name) && $0.value != nil }) else { throw NativeVaultFailure.invalidSignerConnection }
    let entries = query.filter { $0.name == "relay" }
    guard (1...3).contains(entries.count), entries.allSatisfy({ $0.value != nil }), query.filter({ $0.name == "secret" }).count <= 1 else { throw NativeVaultFailure.invalidSignerConnection }
    let relays: [String]
    do { relays = try entries.map { try NativeSignerRelayPolicy.normalized($0.value!) } } catch { throw NativeVaultFailure.invalidSignerConnection }
    guard Set(relays).count == relays.count else { throw NativeVaultFailure.invalidSignerConnection }
    let secret = query.first { $0.name == "secret" }?.value ?? ""
    guard secret.utf8.count <= 1024, secret.utf8.allSatisfy({ $0 >= 33 && $0 < 127 }) else { throw NativeVaultFailure.invalidSignerConnection }
    self.peer = peer; self.relays = relays; token = Data(secret.utf8)
  }
  mutating func clear() { token.resetBytes(in: 0..<token.count); token.removeAll() }
}

enum NativeNip46Protocol {
  static let maximumPlaintext = 4_202_496
  static let maximumEnvelope = 6_990_604 + 2048
  static func encode(_ value: SignerJSONValue) throws -> String {
    switch value {
    case .object(let object): return "{" + (try object.keys.sorted().map { ExactSignerEvent.quote($0) + ":" + (try encode(object[$0]!)) }).joined(separator: ",") + "}"
    case .array(let array): return "[" + (try array.map(encode)).joined(separator: ",") + "]"
    case .string(let string): return ExactSignerEvent.quote(string)
    case .integer(let integer): return String(integer)
    case .null: return "null"
    case .boolean(let bool): return bool ? "true" : "false"
    }
  }
  static func request(id: String, method: String, params: [String]) throws -> Data {
    guard id.utf8.count == 36, ["connect", "get_public_key", "switch_relays", "sign_event"].contains(method) else { throw NativeVaultFailure.signerUnsupported }
    let raw = "{\"id\":\(ExactSignerEvent.quote(id)),\"method\":\(ExactSignerEvent.quote(method)),\"params\":[" + params.map(ExactSignerEvent.quote).joined(separator: ",") + "]}"
    guard raw.utf8.count >= 1, raw.utf8.count <= maximumPlaintext else { throw NativeVaultFailure.signerUnsupported }; return Data(raw.utf8)
  }
  static func outer(plaintext: Data, peer: String, key: NativeVaultKey, now: UInt64) throws -> String {
    var payload = try key.encrypt(peer: peer, plaintext: plaintext); defer { payload.resetBytes(in: 0..<payload.count) }
    guard let content = String(data: payload, encoding: .utf8) else { throw NativeVaultFailure.signerResponseInvalid }
    let pubkey = try key.publicKey()
    let raw = "{\"pubkey\":\(ExactSignerEvent.quote(pubkey)),\"created_at\":\(now),\"kind\":24133,\"tags\":[[\"p\",\(ExactSignerEvent.quote(peer))]],\"content\":\(ExactSignerEvent.quote(content))}"
    let event = try ExactSignerEvent(json: raw, expectedPubkey: pubkey, maximumBytes: maximumEnvelope)
    return try key.sign(event)
  }
  /// Returns nil for a verified but unrelated RPC response. Malformed peer responses always deny.
  static func response(outer: String, peer: String, key: NativeVaultKey, id: String, now: UInt64, authURL: ((String) throws -> Void)? = nil) throws -> SignerJSONValue? {
    do {
    let verified = try NativeNostrSignedEvent(json: outer, peer: peer, maximumBytes: maximumEnvelope)
    let event = verified.event, client = try key.publicKey()
    guard event.kind == 24133, event.tags == [["p", client]], event.createdAt <= now + 30,
      now <= event.createdAt + 120 else { throw NativeVaultFailure.signerResponseInvalid }
    var bytes = try key.decryptAuthenticated(peer: peer, payload: Data(event.content.utf8)); defer { bytes.resetBytes(in: 0..<bytes.count) }
    guard let raw = String(data: bytes, encoding: .utf8) else { throw NativeVaultFailure.signerResponseInvalid }
    var parser = SignerJSONParser(raw, maximumBytes: maximumPlaintext)
    guard case .object(let object) = try parser.parse(), Set(object.keys).isSubset(of: Set(["id", "result", "error"])),
      case .string(let replyID) = object["id"] else { throw NativeVaultFailure.signerResponseInvalid }
    guard replyID == id else { return nil }
    if case .string(let result) = object["result"], result == "auth_url" {
      guard let authURL else { throw NativeVaultFailure.signerUnsupported }
      guard case .string(let url) = object["error"], !url.isEmpty, url.utf8.count <= 2048 else { throw NativeVaultFailure.signerResponseInvalid }
      try authURL(url); return nil
    }
    if let error = object["error"] {
      if case .null = error {}
      else { guard case .string(let message) = error, !message.isEmpty, message.utf8.count <= 1024, object["result"] == nil else { throw NativeVaultFailure.signerResponseInvalid }; throw NativeVaultFailure.signerRejected }
    }
    guard let result = object["result"] else { throw NativeVaultFailure.signerResponseInvalid }; return result
    } catch let failure as NativeVaultFailure { throw failure }
    catch { throw NativeVaultFailure.signerResponseInvalid }
  }
  static func acceptsConnectAcknowledgement(_ value: SignerJSONValue, token: Data) -> Bool {
    guard case .string(let accepted) = value else { return false }
    if accepted == "ack" { return true }
    guard !token.isEmpty, accepted.utf8.count == token.count else { return false }
    var received = Data(accepted.utf8); defer { received.resetBytes(in: 0..<received.count) }
    return token.withUnsafeBytes { supplied in received.withUnsafeBytes { returned in
      timingsafe_bcmp(supplied.baseAddress!, returned.baseAddress!, token.count) == 0
    } }
  }
  static func publicKey(_ value: SignerJSONValue) throws -> String {
    guard case .string(let pubkey) = value, NativeVaultRecord.isPoint(pubkey) else { throw NativeVaultFailure.signerResponseInvalid }; return pubkey
  }
  static func switchedRelays(_ value: SignerJSONValue, saved: [String]) throws -> [String] {
    let decoded: SignerJSONValue
    if case .string(let string) = value { var parser = SignerJSONParser(string, maximumBytes: 8192); decoded = try parser.parse() } else { decoded = value }
    if case .null = decoded { return saved }
    guard case .array(let entries) = decoded, (1...3).contains(entries.count) else { throw NativeVaultFailure.signerResponseInvalid }
    let relays = try entries.map { entry -> String in
      guard case .string(let relay) = entry else { throw NativeVaultFailure.signerResponseInvalid }
      do { return try NativeSignerRelayPolicy.normalized(relay) } catch { throw NativeVaultFailure.signerResponseInvalid }
    }
    guard Set(relays).count == relays.count else { throw NativeVaultFailure.signerResponseInvalid }; return relays
  }
}
