import Foundation

/// A bounded prop containing claims and a one-use handle, never HTML or a URL.
struct PublishedArtifactHostInput {
  let claims: PublishedArtifactRegistry.Claims
  let handle: String
  let configuration: String?

  init?(_ raw: String) {
    guard raw.utf8.count <= 12 * 1024, let data = raw.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(["sessionId", "publisher", "appId", "eventId", "version", "htmlHash", "handle"]).isSubset(of: Set(value.keys)),
      Set(value.keys).subtracting(["sessionId", "publisher", "appId", "eventId", "version", "htmlHash", "handle", "configuration"]).isEmpty,
      let sessionId = value["sessionId"] as? String,
      let publisher = value["publisher"] as? String,
      let appId = value["appId"] as? String,
      let eventId = value["eventId"] as? String,
      let version = value["version"] as? String,
      let htmlHash = value["htmlHash"] as? String,
      let handle = value["handle"] as? String,
      sessionId.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
      [publisher, eventId, version, htmlHash].allSatisfy({
        $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
      }),
      !appId.isEmpty, appId.utf8.count <= 255,
      appId == appId.trimmingCharacters(in: .whitespacesAndNewlines),
      appId.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
      handle == UUID(uuidString: handle)?.uuidString.lowercased(),
      value["configuration"] == nil || value["configuration"] is String,
      (value["configuration"] as? String)?.utf8.count ?? 0 <= 8192 else { return nil }
    claims = .init(sessionId: sessionId, publisher: publisher, identifier: appId,
      eventId: eventId, aggregateHash: version, htmlHash: htmlHash)
    self.handle = handle
    configuration = value["configuration"] as? String
  }
}

/// Sequential, one-use byte owner for the native host generation.
/// The claimed copy disappears on the last read, any invalid sequence or teardown.
final class PublishedArtifactReadOwner {
  private let claims: PublishedArtifactRegistry.Claims
  private let generation: String
  private let totalBytes: Int
  private let domains: [String]
  private var bytes: Data?
  private var offset = 0
  private var nextSequence = 0

  init(claimed: PublishedArtifactRegistry.ClaimedArtifact, domains: Set<String>) {
    claims = claimed.claims
    generation = claimed.viewGeneration
    totalBytes = claimed.htmlBytes.count
    self.domains = domains.sorted()
    bytes = claimed.htmlBytes
  }

  func read(sequence: Int) -> String? {
    guard let bytes, sequence >= 0, sequence == nextSequence else { clear(); return nil }
    let end = min(offset + PublishedArtifactTransfer.maximumChunkBytes, totalBytes)
    guard end > offset else { clear(); return nil }
    let chunk = bytes[offset..<end]
    let done = end == totalBytes
    let response: [String: Any] = [
      "type": "artifact.chunk", "sessionId": generation, "sequence": sequence,
      "base64": chunk.base64EncodedString(), "byteLength": chunk.count,
      "totalBytes": totalBytes, "publisher": claims.publisher,
      "appId": claims.identifier, "eventId": claims.eventId,
      "version": claims.aggregateHash, "htmlHash": claims.htmlHash, "done": done,
      "domains": domains
    ]
    guard let encoded = try? JSONSerialization.data(withJSONObject: response) else { clear(); return nil }
    offset = end
    nextSequence += 1
    if done { clear() }
    return String(decoding: encoded, as: UTF8.self)
  }

  func clear() { bytes = nil }
  deinit { clear() }
}
