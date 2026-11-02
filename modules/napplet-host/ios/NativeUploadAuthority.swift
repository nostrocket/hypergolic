import Foundation
import CryptoKit

/// Native-only exact upload bodies and grants. Caller/frame/sequence admission belongs to the host.
/// This core alone enables no signer, bridge operation or network effect.
final class NativeUploadAuthority: @unchecked Sendable {
  static let maxBytes = 10 * 1024 * 1024
  static let chunkBytes = 256 * 1024
  static let reviewMS: Int64 = 600_000
  static let transferMS: Int64 = 60_000
  final class Session: @unchecked Sendable {
    fileprivate let generation: String
    fileprivate let identity: String
    fileprivate init(_ generation: String, _ identity: String) { self.generation = generation; self.identity = identity }
  }
  final class Request: @unchecked Sendable { fileprivate init() {} }
  final class Grant: @unchecked Sendable {
    fileprivate let request: Request
    fileprivate let owner: UUID
    fileprivate var dispatched = false
    fileprivate init(_ request: Request, _ owner: UUID) { self.request = request; self.owner = owner }
  }
  final class Review: Sendable {
    let purpose = "blossom-upload"
    let identity: String
    let destination: String
    let mimeType: String
    let metadataPolicy: String
    let sha256: String
    let size: Int
    private let validatedWav: Bool
    func acceptsDescriptorType(_ type: String?) -> Bool {
      type == mimeType || validatedWav && type == "audio/x-wav"
    }
    fileprivate init(_ row: Row) {
      identity = row.session.identity; destination = row.destination; mimeType = row.mimeType; metadataPolicy = row.metadataPolicy
      validatedWav = row.mimeType == "audio/wav" && UploadFileProfile.attachmentType([UInt8](row.body)) == "audio/wav"
      size = row.body.count; sha256 = SHA256.hash(data: row.body).map { String(format: "%02x", $0) }.joined()
    }
  }
  fileprivate final class Row {
    let request: Request
    let session: Session
    let destination: String
    var mimeType: String
    var metadataPolicy = "attachment-unchanged"
    var body: Data
    var cursor = 0
    var expires: Int64
    var review: Review?
    var grant: Grant?
    var signingClaimed = false
    var executionPaused = false
    var transferClaimed = false
    var dispatched = false
    init(_ request: Request, _ session: Session, _ destination: String, _ mimeType: String, _ length: Int, _ expires: Int64) {
      self.request = request; self.session = session; self.destination = destination; self.mimeType = mimeType
      body = Data(count: length); self.expires = expires
    }
    func clear() { body.resetBytes(in: 0..<body.count) }
  }
  private let lock = NSLock()
  private let owner = UUID()
  private let clock: @Sendable () -> Int64
  private let prepare: @Sendable (Data) -> UploadFileProfile.Prepared?
  private var sessions: [String: Session] = [:]
  private var requests: [ObjectIdentifier: Row] = [:]
  private var focused: Session?
  private var foreground = false
  private var clockFailed = false
  private var lastTime: Int64 = -1

  init(clock: @escaping @Sendable () -> Int64, prepare: @escaping @Sendable (Data) -> UploadFileProfile.Prepared? = UploadFileProfile.prepare) { self.clock = clock; self.prepare = prepare }
  func register(_ generation: String, identity: String) -> Session? {
    lock.withLock {
      prune()
      guard !clockFailed, Self.matches(generation, "^[A-Za-z0-9_-]{1,80}$"), Self.matches(identity, "^[0-9a-f]{64}$"),
        sessions[generation] == nil, sessions.count < 64 else { return nil }
      let session = Session(generation, identity); sessions[generation] = session; return session
    }
  }
  func setForeground(_ active: Bool) {
    lock.withLock {
      prune(); foreground = active
      if !active { for row in requests.values { row.clear() }; requests.removeAll() }
    }
  }
  func focus(_ session: Session?) { lock.withLock { prune(); if session == nil || registered(session) { focused = session } } }
  func clearFocus(_ session: Session) -> Bool {
    lock.withLock { prune(); guard focused === session else { return false }; focused = nil; return true }
  }
  func revoke(_ session: Session) {
    lock.withLock {
      prune(); guard registered(session) else { return }
      sessions.removeValue(forKey: session.generation); if focused === session { focused = nil }
      for key in requests.keys.filter({ requests[$0]?.session === session }) { requests.removeValue(forKey: key)?.clear() }
    }
  }
  func revokeAll() {
    lock.withLock { for row in requests.values { row.clear() }; requests.removeAll(); sessions.removeAll(); focused = nil }
  }
  /// The exact canonical origin is captured once. The PUT owner must independently pin public DNS/TLS.
  func admit(_ session: Session, length: Int, destination: String, mimeType: String) -> Request? {
    lock.withLock {
      prune()
      guard !clockFailed, foreground, registered(session), (0...Self.maxBytes).contains(length),
        Self.validDestination(destination), mimeType.utf8.count <= 128,
        Self.matches(mimeType, "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$"),
        requests.count < 10, requests.values.filter({$0.grant == nil}).count < 8, !requests.values.contains(where: { $0.session === session }),
        lastTime <= Int64.max - Self.reviewMS else { return nil }
      let request = Request()
      requests[ObjectIdentifier(request)] = Row(request, session, destination, mimeType, length, lastTime + Self.reviewMS)
      return request
    }
  }
  func append(_ request: Request, offset: Int, chunk: Data) -> Bool {
    lock.withLock {
      prune()
      guard let row = live(request), row.review == nil, !chunk.isEmpty, chunk.count <= Self.chunkBytes,
        offset == row.cursor, chunk.count <= row.body.count - row.cursor else { return false }
      row.body.replaceSubrange(row.cursor..<(row.cursor + chunk.count), with: chunk); row.cursor += chunk.count; return true
    }
  }
  func seal(_ request: Request) -> Review? {
    lock.withLock {
      prune(); guard let row = live(request), row.review == nil, row.cursor == row.body.count else { return nil }
      let review = Review(row); row.review = review; return review
    }
  }
  /// Native byte preparation happens before hashing/review, independently of the guest MIME.
  func sealPreparedFile(_ request: Request) -> Review? {
    lock.withLock {
      prune(); guard let row = live(request), row.review == nil, row.cursor == row.body.count else { return nil }
      guard let result = prepare(row.body) else {
        requests.removeValue(forKey: ObjectIdentifier(request))?.clear(); return nil
      }
      row.clear(); row.body = result.bytes; row.cursor = result.bytes.count; row.mimeType = result.mimeType; row.metadataPolicy = result.metadataPolicy
      let review = Review(row); row.review = review; return review
    }
  }
  func pauseExecution(_ request: Request, paused: Bool) -> Bool {
    lock.withLock {
      prune(); guard let row = live(request), row.session === focused, !row.dispatched,
        row.executionPaused != paused else { return false }
      row.executionPaused = paused; return true
    }
  }
  func contains(_ request: Request) -> Bool { lock.withLock { prune(); return live(request) != nil } }
  func mayReview(_ request: Request, expected: Review) -> Bool {
    lock.withLock { prune(); return reviewable(request, expected) }
  }
  func preview(_ request: Request, expected: Review) -> Data? {
    lock.withLock { prune(); return reviewable(request, expected) ? live(request)?.body : nil }
  }
  func previewChunk(_ request: Request, expected: Review, offset: Int) -> Data? {
    lock.withLock {
      prune(); guard reviewable(request, expected), let row = live(request), offset >= 0,
        offset < row.body.count, offset % Self.chunkBytes == 0 else { return nil }
      return row.body.subdata(in: offset..<min(row.body.count, offset + Self.chunkBytes))
    }
  }
  func approve(_ request: Request, expected: Review) -> Grant? {
    lock.withLock {
      prune(); guard reviewable(request, expected), requests.values.filter({$0.grant != nil}).count < 2, lastTime <= Int64.max - Self.transferMS,
        let row = live(request) else { return nil }
      let grant = Grant(request, owner); row.grant = grant; row.expires = lastTime + Self.transferMS; return grant
    }
  }
  func approvedReview(_ grant: Grant) -> Review? { lock.withLock { prune(); return approved(grant)?.review } }
  func isApproved(_ grant: Grant) -> Bool { lock.withLock { prune(); return approved(grant) != nil } }
  /// One claim; the protected signer must verify this exact Review's purpose/identity/hash/server template too.
  func claimSigning(_ grant: Grant) -> Review? {
    lock.withLock {
      prune(); guard let row = approved(grant), !row.signingClaimed else { return nil }
      row.signingClaimed = true; return row.review
    }
  }
  func claimTransfer(_ grant: Grant) -> Bool {
    lock.withLock {
      prune(); guard let row = approved(grant), row.signingClaimed, !row.transferClaimed else { return false }
      row.transferClaimed = true; return true
    }
  }
  func cancelGrant(_ grant: Grant) {
    lock.withLock { if grant.owner == owner { requests.removeValue(forKey: ObjectIdentifier(grant.request))?.clear() } }
  }
  /// One dispatch. The network owner retains the native grant and rechecks it during I/O.
  func dispatch(_ grant: Grant) -> Data? {
    lock.withLock {
      prune(); guard let row = approved(grant), row.signingClaimed, row.transferClaimed, !row.dispatched else { return nil }
      row.dispatched = true; grant.dispatched = true; return row.body
    }
  }
  /// Sticky local dispatch evidence survives cancellation; it never claims remote deletion or success.
  func wasDispatched(_ grant: Grant) -> Bool { lock.withLock { grant.owner == owner && grant.dispatched } }
  func cancel(_ request: Request) { lock.withLock { requests.removeValue(forKey: ObjectIdentifier(request))?.clear() } }
  func finish(_ grant: Grant) {
    lock.withLock { prune(); if approved(grant) != nil { requests.removeValue(forKey: ObjectIdentifier(grant.request))?.clear() } }
  }
  private func registered(_ session: Session?) -> Bool { guard let session else { return false }; return sessions[session.generation] === session }
  private func live(_ request: Request) -> Row? {
    guard foreground, let row = requests[ObjectIdentifier(request)], registered(row.session) else { return nil }; return row
  }
  private func approved(_ grant: Grant) -> Row? {
    guard grant.owner == owner, let row = live(grant.request), row.grant === grant, !row.executionPaused else { return nil }; return row
  }
  private func reviewable(_ request: Request, _ expected: Review) -> Bool {
    guard let row = live(request) else { return false }; return !row.executionPaused && row.session === focused && row.review === expected && row.grant == nil
  }
  private func prune() {
    let now = clock(); if now < 0 || now < lastTime { clockFailed = true }; if !clockFailed { lastTime = now }
    for key in requests.keys.filter({ key in
      guard let row = requests[key] else { return true }; return clockFailed || now >= row.expires || !registered(row.session)
    }) { requests.removeValue(forKey: key)?.clear() }
  }
  private static func matches(_ value: String, _ pattern: String) -> Bool {
    guard let range = value.range(of: pattern, options: .regularExpression) else { return false }; return range == value.startIndex..<value.endIndex
  }
  static func validDestination(_ input: String) -> Bool {
    guard input.utf8.count <= 2048, input.utf8.allSatisfy({ (33...126).contains($0) }), !input.contains("\\"),
      let url = URLComponents(string: input), url.scheme == "https", url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil, url.percentEncodedPath.isEmpty, let host = url.host,
      host.utf8.count <= 253, host == host.lowercased(), host.contains("."), !matches(host, "^[0-9.]+$"),
      url.port == nil || ((1...65535).contains(url.port!) && url.port != 443),
      !["localhost","local","internal","home","home.arpa","lan","test","example","invalid","onion","arpa"].contains(where: { host == $0 || host.hasSuffix("." + $0) }),
      host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ matches(String($0), "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" ) })
    else { return false }
    return input == "https://" + host + (url.port.map { ":\($0)" } ?? "")
  }
}
