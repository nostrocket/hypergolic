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
      Set(value.keys).subtracting(["sessionId", "publisher", "appId", "eventId", "version", "htmlHash", "handle", "configuration", "snapshot"]).isEmpty,
      let sessionId = value["sessionId"] as? String,
      let publisher = value["publisher"] as? String,
      let appId = value["appId"] as? String,
      let eventId = value["eventId"] as? String,
      let version = value["version"] as? String,
      let htmlHash = value["htmlHash"] as? String,
      let handle = value["handle"] as? String,
      handle == UUID(uuidString: handle)?.uuidString.lowercased(),
      value["configuration"] == nil || value["configuration"] is String,
      (value["configuration"] as? String)?.utf8.count ?? 0 <= 8192 else { return nil }
    let snapshot = value["snapshot"].flatMap(PublishedArtifactRegistry.Snapshot.init)
    guard value["snapshot"] == nil || (snapshot != nil && value["configuration"] != nil) else { return nil }
    let claims = PublishedArtifactRegistry.Claims(sessionId: sessionId, publisher: publisher, identifier: appId,
      eventId: eventId, aggregateHash: version, htmlHash: htmlHash, snapshot: snapshot)
    guard PublishedArtifactRegistry.valid(claims) else { return nil }
    self.claims = claims
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
  private let publishedOpen: Bool
  private let appData: String?
  private let legacyReadOnly: String?
  private var bytes: Data?
  private var offset = 0
  private var nextSequence = 0

  init(claimed: PublishedArtifactRegistry.ClaimedArtifact, domains: Set<String>, publishedOpen: Bool = false, appData: String? = nil, legacyReadOnly: String? = nil) {
    claims = claimed.claims
    generation = claimed.viewGeneration
    totalBytes = claimed.htmlBytes.count
    self.domains = domains.sorted()
    self.publishedOpen = publishedOpen
    self.appData = appData
    self.legacyReadOnly = legacyReadOnly
    bytes = claimed.htmlBytes
  }

  func read(sequence: Int) -> String? {
    guard let bytes, sequence >= 0, sequence == nextSequence else { clear(); return nil }
    let end = min(offset + PublishedArtifactTransfer.maximumChunkBytes, totalBytes)
    guard end > offset else { clear(); return nil }
    let chunk = bytes[offset..<end]
    let done = end == totalBytes
    var response: [String: Any] = [
      "type": "artifact.chunk", "sessionId": generation, "sequence": sequence,
      "base64": chunk.base64EncodedString(), "byteLength": chunk.count,
      "totalBytes": totalBytes, "publisher": claims.publisher,
      "appId": claims.identifier, "eventId": claims.eventId,
      "version": claims.aggregateHash, "htmlHash": claims.htmlHash, "done": done,
      "domains": domains
    ]
    if let snapshot = claims.snapshot { response["snapshot"] = snapshot.wire }
    if let legacyReadOnly, let data = legacyReadOnly.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) { response["legacyReadOnly"] = value }
    if let appData, let data = appData.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with:data) { response["appData"] = value }
    if publishedOpen { response["publishedOpen"] = true }
    guard let encoded = try? JSONSerialization.data(withJSONObject: response) else { clear(); return nil }
    offset = end
    nextSequence += 1
    if done { clear() }
    return String(decoding: encoded, as: UTF8.self)
  }

  func clear() { bytes = nil }
  deinit { clear() }
}
