import Foundation

/// Native-captured registration and private lookup tokens. Host origin/frame/sequence/schema gates precede admission.
final class UploadLeaseRegistry: @unchecked Sendable {
  struct Taken: Sendable {
    let registration: String
    let request: String
    let uploadId: String
    let review: NativeUploadAuthority.Review
  }
  struct Transfer: Sendable {
    let authority: NativeUploadAuthority
    let grant: NativeUploadAuthority.Grant
    let permit: NativeBlossomPermit
    let registration: String
    let uploadId: String
  }
  struct Invalid: Sendable { let token: String; let generation: String; let uploadId: String; let dispatched: Bool }
  private final class Session {
    let generation: String
    let registration: String
    let handle: NativeUploadAuthority.Session
    var callerIds = Set<String>()
    init(_ generation: String, _ registration: String, _ handle: NativeUploadAuthority.Session) {
      self.generation = generation; self.registration = registration; self.handle = handle
    }
  }
  private final class Row {
    let session: Session
    let requestText: String
    let uploadId = UUID().uuidString.lowercased()
    let request: NativeUploadAuthority.Request
    var cursor = 0
    var claimed = false
    var nativeSigningClaimed = false
    var nativeHandoffPending = false
    var review: NativeUploadAuthority.Review?
    var grant: NativeUploadAuthority.Grant?
    init(_ session: Session, _ requestText: String, _ request: NativeUploadAuthority.Request) {
      self.session = session; self.requestText = requestText; self.request = request
    }
  }
  private let lock = NSLock()
  private let authority: NativeUploadAuthority
  private var sessions: [String: Session] = [:]
  private var rows: [String: Row] = [:]
  private var dispatchedHistory: [String: Bool] = [:]
  private var historyOrder: [String] = []
  init(clock: @escaping @Sendable () -> Int64, prepare: @escaping @Sendable (Data) -> UploadFileProfile.Prepared? = UploadFileProfile.prepare) { authority = NativeUploadAuthority(clock: clock, prepare: prepare) }
  func register(_ generation: String, identity: String, registration: String, granted: Bool) -> Bool {
    lock.withLock {
      guard granted, registration.utf8.count <= 8192, sessions[generation] == nil,
        let handle = authority.register(generation, identity: identity) else { return false }
      sessions[generation] = Session(generation, registration, handle); return true
    }
  }
  func isRegistered(_ generation: String) -> Bool { lock.withLock {sessions[generation] != nil} }
  func foreground(_ active: Bool) { lock.withLock { authority.setForeground(active) } }
  func focus(_ generation: String, active: Bool) {
    lock.withLock { guard let session = sessions[generation] else { return }; if active { authority.focus(session.handle) } else { _ = authority.clearFocus(session.handle) } }
  }
  func begin(_ generation: String, callerId: String, requestText: String, length: Int, destination: String) -> String? {
    lock.withLock {
      guard let session = sessions[generation], (1...128).contains(callerId.utf8.count), requestText.utf8.count <= 32 * 1024,
        rows.count < 10, session.callerIds.count < 1024, !session.callerIds.contains(callerId),
        !rows.values.contains(where: {$0.session === session}),
        let request = authority.admit(session.handle, length: length, destination: destination, mimeType: "application/octet-stream") else { return nil }
      let token = UUID().uuidString.lowercased(), row = Row(session, requestText, request)
      guard token != row.uploadId, rows[token] == nil else { authority.cancel(request); return nil }
      session.callerIds.insert(callerId); rows[token] = row; return token
    }
  }
  func publicId(_ generation: String, token: String) -> String? { lock.withLock { owned(generation, token)?.uploadId } }
  func publicIdForApp(_ token: String) -> String? { lock.withLock { guard let row = rows[token], row.claimed else { return nil }; return row.uploadId } }
  func append(_ generation: String, token: String, offset: Int, chunk: Data) -> Int? {
    lock.withLock {
      guard let row = owned(generation, token), !row.claimed, row.review == nil,
        authority.append(row.request, offset: offset, chunk: chunk) else { return nil }
      row.cursor += chunk.count; return row.cursor
    }
  }
  func seal(_ generation: String, token: String) -> Bool {
    lock.withLock {
      guard let row = owned(generation, token), !row.claimed, row.review == nil else { return false }
      row.review = authority.sealPreparedFile(row.request); return row.review != nil
    }
  }
  func sealedReview(_ generation: String, token: String) -> NativeUploadAuthority.Review? { lock.withLock { owned(generation, token)?.review } }
  func take(_ token: String) -> Taken? {
    lock.withLock {
      guard let row = rows[token], !row.claimed, let review = row.review, authority.contains(row.request) else { return nil }
      row.claimed = true; return Taken(registration: row.session.registration, request: row.requestText, uploadId: row.uploadId, review: review)
    }
  }
  func signingCapture(_ token: String) -> Taken? {
    lock.withLock {
      guard let row = rows[token], row.claimed, !row.nativeSigningClaimed,
        let review = row.review, approved(token) else { return nil }
      return Taken(registration: row.session.registration, request: row.requestText, uploadId: row.uploadId, review: review)
    }
  }
  func claimNativeSigning(_ token: String, expected: NativeUploadAuthority.Review) -> Bool {
    lock.withLock {
      guard let row = rows[token], row.claimed, !row.nativeSigningClaimed,
        row.review === expected, approved(token) else { return false }
      row.nativeSigningClaimed = true; return true
    }
  }
  func isLive(_ token: String) -> Bool { lock.withLock { guard let row = rows[token] else { return false }; return !row.nativeHandoffPending && row.claimed && authority.contains(row.request) } }
  func nativeSigningLifetime(_ token: String) -> Bool {
    lock.withLock { guard let row = rows[token], row.claimed, row.nativeSigningClaimed else { return false }; return authority.contains(row.request) }
  }
  func pauseNativeSigning(_ token: String, paused: Bool) -> Bool {
    lock.withLock {
      guard let row = rows[token], row.claimed, row.nativeSigningClaimed, row.nativeHandoffPending != paused,
        authority.pauseExecution(row.request, paused: paused) else { return false }
      row.nativeHandoffPending = paused; return true
    }
  }
  func mayReview(_ token: String) -> Bool { lock.withLock { reviewable(token) } }
  func preview(_ token: String, offset: Int) -> Data? {
    lock.withLock {
      guard let row = rows[token], let review = row.review, reviewable(token) else { return nil }
      return authority.previewChunk(row.request, expected: review, offset: offset)
    }
  }
  func approve(_ token: String) -> Bool {
    lock.withLock {
      guard let row = rows[token], let review = row.review, reviewable(token), row.grant == nil else { return false }
      row.grant = authority.approve(row.request, expected: review); return row.grant != nil
    }
  }
  func isApproved(_ token: String) -> Bool { lock.withLock { approved(token) } }
  func claimSigning(_ token: String) -> Bool {
    lock.withLock {
      guard let row = rows[token], row.claimed, let grant = row.grant, let review = row.review else { return false }
      return authority.claimSigning(grant) === review
    }
  }
  func transfer(_ token: String, credential: String, now: Int64) -> Transfer? {
    lock.withLock {
      guard let row = rows[token], approved(token), let grant = row.grant, let review = row.review,
        let permit = NativeBlossomPermit.capture(review, token: credential, now: now) else { return nil }
      return Transfer(authority: authority, grant: grant, permit: permit, registration: row.session.registration, uploadId: row.uploadId)
    }
  }
  func wasDispatched(_ token: String) -> Bool {
    lock.withLock {
      if let row = rows[token] { return row.grant.map {authority.wasDispatched($0)} ?? false }
      return dispatchedHistory[token] ?? true // Missing evidence cannot prove no dispatch.
    }
  }
  func cancelOwned(_ generation: String, token: String) -> Bool {
    lock.withLock { guard let row = owned(generation, token) else { return false }; authority.cancel(row.request); return true }
  }
  func cancel(_ token: String) { lock.withLock { if let row = rows[token] { authority.cancel(row.request) } } }
  func finish(_ token: String) -> Bool {
    lock.withLock { guard let row = rows[token] else { return false }; let result = approved(token); remove(token, row); return result }
  }
  func revoke(_ generation: String) { lock.withLock { if let session = sessions.removeValue(forKey: generation) { authority.revoke(session.handle) } } }
  func revokeAll() { lock.withLock { authority.revokeAll(); sessions.removeAll() } }
  func drainInvalid() -> [Invalid] {
    lock.withLock {
      var result: [Invalid] = []
      for token in Array(rows.keys) {
        guard let row = rows[token] else { continue }
        if sessions[row.session.generation] === row.session && authority.contains(row.request) { continue }
        result.append(Invalid(token: token, generation: row.session.generation, uploadId: row.uploadId,
          dispatched: row.grant.map {authority.wasDispatched($0)} ?? false)); remove(token, row)
      }
      return result
    }
  }
  private func owned(_ generation: String, _ token: String) -> Row? {
    guard let row = rows[token], row.session === sessions[generation], row.session.generation == generation else { return nil }; return row
  }
  private func reviewable(_ token: String) -> Bool {
    guard let row = rows[token], row.claimed, let review = row.review else { return false }; return authority.mayReview(row.request, expected: review)
  }
  private func approved(_ token: String) -> Bool {
    guard let row = rows[token], row.claimed, let grant = row.grant else { return false }; return authority.isApproved(grant)
  }
  private func remove(_ token: String, _ row: Row) {
    dispatchedHistory[token] = row.grant.map {authority.wasDispatched($0)} ?? false; historyOrder.append(token)
    if historyOrder.count > 128 { dispatchedHistory.removeValue(forKey: historyOrder.removeFirst()) }
    rows.removeValue(forKey: token); authority.cancel(row.request)
  }
}
