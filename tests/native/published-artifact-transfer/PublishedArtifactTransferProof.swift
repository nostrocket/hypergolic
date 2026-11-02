import CryptoKit
import Foundation

private final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var instant = ContinuousClock.now
  func now() -> ContinuousClock.Instant { lock.withLock { instant } }
  func advance(_ seconds: Int64) { lock.withLock { instant = instant.advanced(by: .seconds(seconds)) } }
}

@main private struct PublishedArtifactTransferProof {
  static func main() throws {
    var checks = 0
    func check(_ condition: Bool, _ label: String) throws {
      guard condition else { throw NSError(domain: label, code: 1) }
      checks += 1
    }
    func hash(_ data: Data) -> String {
      SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    func claims(_ data: Data, session: String) -> PublishedArtifactRegistry.Claims {
      let htmlHash = hash(data)
      return .init(sessionId: session, publisher: String(repeating: "a", count: 64),
        identifier: "test-napplet", eventId: String(repeating: "b", count: 64),
        aggregateHash: hash(Data("\(htmlHash) /index.html\n".utf8)), htmlHash: htmlHash)
    }
    func begin(_ transfer: PublishedArtifactTransfer, _ claim: PublishedArtifactRegistry.Claims,
               _ length: Int) -> String? {
      transfer.beginPublishedArtifact(sessionId: claim.sessionId, publisher: claim.publisher,
        identifier: claim.identifier, eventId: claim.eventId, aggregateHash: claim.aggregateHash,
        htmlHash: claim.htmlHash, byteLength: length)
    }

    let clock = TestClock()
    let registry = PublishedArtifactRegistry(now: { clock.now() })
    let transfer = PublishedArtifactTransfer(registry: registry, now: { clock.now() })
    let html = Data("<!doctype html><title>Real bytes 🦊</title>".utf8)
    let claim = claims(html, session: "session-a")
    try check(begin(transfer, claim, html.count) == nil, "unregistered session denied")
    try check(transfer.registerPublishedSession("session-a"), "register session")
    try check(begin(transfer, claim, 0) == nil, "zero length denied")
    try check(begin(transfer, claim, PublishedArtifactRegistry.maximumHTMLBytes + 1) == nil, "oversize declaration denied")
    let upload = begin(transfer, claim, html.count)!
    try check(UUID(uuidString: upload) != nil, "opaque random upload ID")
    try check(begin(transfer, claim, html.count) == nil, "one upload per session")
    let first = html.prefix(7)
    let second = html.dropFirst(7)
    try check(transfer.appendPublishedArtifact(upload, sequence: 0, base64Chunk: first.base64EncodedString()), "first real chunk")
    try check(transfer.appendPublishedArtifact(upload, sequence: 1, base64Chunk: second.base64EncodedString()), "second real chunk")
    let token = transfer.finishPublishedArtifact(upload)
    try check(token != nil, "complete transfer stages token")
    try check(transfer.finishPublishedArtifact(upload) == nil, "finish replay denied")
    try check(registry.claim(token!, claims: claim, viewGeneration: "view-1")?.htmlBytes == html, "genuine bytes reached native registry")
    try check(registry.claim(token!, claims: claim, viewGeneration: "view-2") == nil, "registry claim replay denied")
    let exact = Data(repeating: 0x61, count: PublishedArtifactRegistry.maximumHTMLBytes)
    let exactClaim = claims(exact, session: "session-a")
    let exactUpload = begin(transfer, exactClaim, exact.count)!
    var offset = 0
    var sequence = 0
    while offset < exact.count {
      let end = min(offset + PublishedArtifactTransfer.maximumChunkBytes, exact.count)
      try check(transfer.appendPublishedArtifact(exactUpload, sequence: sequence,
        base64Chunk: exact[offset..<end].base64EncodedString()), "bounded exact-limit chunk")
      offset = end
      sequence += 1
    }
    let exactToken = transfer.finishPublishedArtifact(exactUpload)
    try check(exactToken != nil, "two MiB transfer stages")
    try check(registry.claim(exactToken!, claims: exactClaim, viewGeneration: "exact-view")?.htmlBytes == exact,
      "two MiB original bytes survive transfer")

    let incomplete = begin(transfer, claim, html.count)!
    try check(transfer.appendPublishedArtifact(incomplete, sequence: 0, base64Chunk: first.base64EncodedString()), "incomplete first chunk")
    try check(transfer.finishPublishedArtifact(incomplete) == nil, "incomplete finish consumes upload")
    try check(!transfer.appendPublishedArtifact(incomplete, sequence: 1, base64Chunk: second.base64EncodedString()), "incomplete replay denied")
    let badOrder = begin(transfer, claim, html.count)!
    try check(!transfer.appendPublishedArtifact(badOrder, sequence: 1, base64Chunk: html.base64EncodedString()), "out of order denied")
    try check(!transfer.appendPublishedArtifact(badOrder, sequence: 0, base64Chunk: html.base64EncodedString()), "out of order consumes upload")
    let badBase64 = begin(transfer, claim, html.count)!
    try check(!transfer.appendPublishedArtifact(badBase64, sequence: 0, base64Chunk: "!!=="), "bad Base64 denied")
    try check(transfer.finishPublishedArtifact(badBase64) == nil, "bad Base64 consumes upload")
    let nonCanonical = begin(transfer, claim, html.count)!
    try check(!transfer.appendPublishedArtifact(nonCanonical, sequence: 0, base64Chunk: "YR=="), "noncanonical Base64 denied")
    let overflow = begin(transfer, claim, 1)!
    try check(!transfer.appendPublishedArtifact(overflow, sequence: 0, base64Chunk: html.base64EncodedString()), "declared length overflow denied")
    try check(transfer.finishPublishedArtifact(overflow) == nil, "overflow consumes upload")
    let large = Data(repeating: 0x61, count: PublishedArtifactTransfer.maximumChunkBytes + 1)
    let oversizedChunk = begin(transfer, claim, html.count)!
    try check(!transfer.appendPublishedArtifact(oversizedChunk, sequence: 0, base64Chunk: large.base64EncodedString()), "oversized chunk denied")

    let badHashClaim = PublishedArtifactRegistry.Claims(sessionId: claim.sessionId,
      publisher: claim.publisher, identifier: claim.identifier, eventId: claim.eventId,
      aggregateHash: claim.aggregateHash, htmlHash: String(repeating: "0", count: 64))
    let mismatch = begin(transfer, badHashClaim, html.count)!
    try check(transfer.appendPublishedArtifact(mismatch, sequence: 0, base64Chunk: html.base64EncodedString()), "mismatch bytes accepted into transfer")
    try check(transfer.finishPublishedArtifact(mismatch) == nil, "registry rejects hash mismatch")
    let badUTF8 = Data([0xff])
    let utf8Upload = begin(transfer, claims(badUTF8, session: "session-a"), 1)!
    try check(transfer.appendPublishedArtifact(utf8Upload, sequence: 0, base64Chunk: badUTF8.base64EncodedString()), "raw byte transfer")
    try check(transfer.finishPublishedArtifact(utf8Upload) == nil, "registry rejects bad UTF-8")

    let expiring = begin(transfer, claim, html.count)!
    clock.advance(60)
    try check(!transfer.appendPublishedArtifact(expiring, sequence: 0, base64Chunk: html.base64EncodedString()), "upload expires at 60 seconds")
    try check(begin(transfer, claim, html.count) != nil, "expired upload frees session capacity")
    transfer.revokePublishedSession("session-a")
    try check(begin(transfer, claim, html.count) == nil, "session revoke denies begin")
    try check(transfer.registerPublishedSession("session-a"), "register after revoke")

    var uploads: [String] = []
    for n in 0..<PublishedArtifactTransfer.maximumUploads {
      let session = "session-\(n)"
      try check(transfer.registerPublishedSession(session), "capacity session registration")
      let id = begin(transfer, claims(html, session: session), html.count)
      try check(id != nil, "capacity upload admitted")
      uploads.append(id!)
    }
    try check(begin(transfer, claim, html.count) == nil, "fifth upload denied")
    transfer.cancelPublishedArtifact(uploads[0])
    try check(begin(transfer, claim, html.count) != nil, "cancel frees capacity")
    transfer.revokeAll()
    try check(begin(transfer, claim, html.count) == nil, "revoke all clears sessions")
    try check(!transfer.appendPublishedArtifact(uploads[1], sequence: 0, base64Chunk: html.base64EncodedString()), "revoke all clears partial bytes")
    print("{\"language\":\"Swift\",\"checks\":\(checks),\"failed\":0}")
  }
}
