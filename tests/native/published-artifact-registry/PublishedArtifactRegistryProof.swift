import CryptoKit
import Foundation

private final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var instant = ContinuousClock.now
  func now() -> ContinuousClock.Instant { lock.withLock { instant } }
  func advance(_ seconds: Int64) { lock.withLock { instant = instant.advanced(by: .seconds(seconds)) } }
}

private final class WinnerCount: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func increment() { lock.withLock { value += 1 } }
  func read() -> Int { lock.withLock { value } }
}

@main private struct PublishedArtifactRegistryProof {
  static func main() throws {
    var checks = 0
    func check(_ condition: Bool, _ label: String) throws {
      guard condition else { throw NSError(domain: label, code: 1) }
      checks += 1
    }
    func hash(_ bytes: Data) -> String {
      SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    func claims(_ html: Data, session: String = "session-a") -> PublishedArtifactRegistry.Claims {
      let htmlHash = hash(html)
      return .init(sessionId: session, publisher: String(repeating: "a", count: 64), identifier: "test-napplet",
                   eventId: String(repeating: "b", count: 64),
                   aggregateHash: hash(Data("\(htmlHash) /index.html\n".utf8)), htmlHash: htmlHash)
    }

    let clock = TestClock()
    let registry = PublishedArtifactRegistry(now: { clock.now() })
    let html = Data("<!doctype html><title>test</title>".utf8)
    let exact = Data(repeating: 0x61, count: PublishedArtifactRegistry.maximumHTMLBytes)
    try check(registry.stage(html, claims: claims(html)) == nil, "unregistered session denied")
    try check(registry.registerSession("session-a"), "register session")
    try check(!registry.registerSession("session-a"), "duplicate session denied")
    try check(!registry.registerSession("bad/session"), "malformed session denied")
    let handle = registry.stage(html, claims: claims(html))
    try check(handle != nil && UUID(uuidString: handle!) != nil, "unguessable UUID handle")
    let wrongSession = claims(html, session: "session-b")
    try check(registry.claim(handle!, claims: wrongSession, viewGeneration: "view-1") == nil, "cross-session denied")
    try check(registry.claim(handle!, claims: claims(html), viewGeneration: "view-1") == nil, "wrong claim consumes token")

    let validHandle = registry.stage(html, claims: claims(html))!
    let claimed = registry.claim(validHandle, claims: claims(html), viewGeneration: "view-1")
    try check(claimed?.htmlBytes == html && claimed?.claims == claims(html) && claimed?.viewGeneration == "view-1", "exact claim returns original bytes and claims")
    try check(registry.claim(validHandle, claims: claims(html), viewGeneration: "view-2") == nil, "one-use replay denied")
    var callerBuffer = html
    let copiedHandle = registry.stage(callerBuffer, claims: claims(html))!
    callerBuffer[0] = 0x58
    try check(registry.claim(copiedHandle, claims: claims(html), viewGeneration: "copy-view")?.htmlBytes == html, "stage owns a private byte copy")
    try check(registry.stage(Data(), claims: claims(Data())) == nil, "empty HTML denied")
    try check(registry.stage(Data([0xff]), claims: claims(Data([0xff]))) == nil, "malformed UTF-8 denied")
    try check(registry.stage(Data(repeating: 0x61, count: PublishedArtifactRegistry.maximumHTMLBytes + 1), claims: claims(exact)) == nil, "over-limit denied")
    let badHash = PublishedArtifactRegistry.Claims(sessionId: "session-a", publisher: String(repeating: "a", count: 64), identifier: "test-napplet", eventId: String(repeating: "b", count: 64), aggregateHash: claims(html).aggregateHash, htmlHash: String(repeating: "0", count: 64))
    try check(registry.stage(html, claims: badHash) == nil, "wrong HTML SHA denied")
    let badAggregate = PublishedArtifactRegistry.Claims(sessionId: "session-a", publisher: String(repeating: "a", count: 64), identifier: "test-napplet", eventId: String(repeating: "b", count: 64), aggregateHash: String(repeating: "0", count: 64), htmlHash: claims(html).htmlHash)
    try check(registry.stage(html, claims: badAggregate) == nil, "wrong aggregate SHA denied")
    try check(registry.stage(html, claims: .init(sessionId: "session-a", publisher: String(repeating: "A", count: 64), identifier: "test-napplet", eventId: claims(html).eventId, aggregateHash: claims(html).aggregateHash, htmlHash: claims(html).htmlHash)) == nil, "malformed publisher claim denied")
    let exactHandle = registry.stage(exact, claims: claims(exact))
    try check(exactHandle != nil, "exact two MiB accepted")
    try check(registry.claim(exactHandle!, claims: claims(exact), viewGeneration: "exact-view")?.htmlBytes == exact, "exact two MiB returned intact")
    let invalidView = registry.stage(html, claims: claims(html))!
    try check(registry.claim(invalidView, claims: claims(html), viewGeneration: "bad/view") == nil, "invalid view generation denied")

    let expiring = registry.stage(html, claims: claims(html))!
    clock.advance(59)
    try check(registry.claim(expiring, claims: claims(html), viewGeneration: "view-2")?.htmlBytes == html, "valid before expiry")
    let expired = registry.stage(html, claims: claims(html))!
    clock.advance(60)
    try check(registry.claim(expired, claims: claims(html), viewGeneration: "view-3") == nil, "exact expiry denied")

    let revoke = registry.stage(html, claims: claims(html))!
    registry.revokeSession("session-a")
    try check(registry.claim(revoke, claims: claims(html), viewGeneration: "view-4") == nil, "session revoke clears staged bytes")
    try check(claimed?.htmlBytes == html, "previously claimed copy remains host-owned after registry revocation")
    try check(registry.stage(html, claims: claims(html)) == nil, "session revoke denies staging until registration")
    try check(registry.registerSession("session-a"), "trusted registration can reopen saved session")
    try check(registry.stage(html, claims: claims(html)) != nil, "reopened session can stage")
    registry.revokeAll()
    try check(registry.stage(html, claims: claims(html)) == nil, "background revoke clears registrations")
    try check(registry.registerSession("session-a"), "foreground may register again")

    var pending: [String] = []
    for _ in 0..<PublishedArtifactRegistry.maximumPending {
      let value = registry.stage(html, claims: claims(html))
      try check(value != nil, "pending capacity")
      pending.append(value!)
    }
    try check(registry.stage(html, claims: claims(html)) == nil, "pending count bounded")
    registry.revokeAll()
    try check(registry.claim(pending[0], claims: claims(html), viewGeneration: "view-5") == nil, "revoke all clears tokens")
    try check(registry.registerSession("session-a"), "register after revoke all")

    let race = registry.stage(html, claims: claims(html))!
    let raceClaims = claims(html)
    let winners = WinnerCount()
    DispatchQueue.concurrentPerform(iterations: 16) { _ in
      if registry.claim(race, claims: raceClaims, viewGeneration: "race-view") != nil { winners.increment() }
    }
    try check(winners.read() == 1, "atomic concurrent claim")
    print("{\"language\":\"Swift\",\"checks\":\(checks),\"failed\":0}")
  }
}
