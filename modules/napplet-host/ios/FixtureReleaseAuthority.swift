import Foundation
import CryptoKit

/// Trusted Settings owner with a private registry; no guest carrier can reach it.
final class FixtureReleaseAuthority: @unchecked Sendable {
  final class Entry: @unchecked Sendable {
    let token: String; let fixture: String; let identity: String; let server: String; let manifestTags: String; let epoch: UInt64
    let session: NativeUploadAuthority.Session; let request: NativeUploadAuthority.Request; let review: NativeUploadAuthority.Review
    var grant: NativeUploadAuthority.Grant?; var verified = false
    var manifestRequest: NativeApprovalRequestHandle?; var manifestGrant: NativeApprovalHandle?
    var manifestSnapshot: String?; var nativeUploadClaimed = false; var nativeManifestClaimed = false; var nativeHandoffManifest: Bool?
    init(_ token: String, _ fixture: String, _ identity: String, _ server: String, _ tags: String, _ epoch: UInt64,
      _ session: NativeUploadAuthority.Session, _ request: NativeUploadAuthority.Request, _ review: NativeUploadAuthority.Review) {
      self.token=token; self.fixture=fixture; self.identity=identity; self.server=server; manifestTags=tags; self.epoch=epoch
      self.session=session; self.request=request; self.review=review
    }
  }
  let uploads: NativeUploadAuthority
  private let manifests = NativeApprovalAuthority()
  private let lock = NSRecursiveLock()
  private var manifestSession: NativeApprovalSessionHandle?
  private var user: String?; private var epoch: UInt64?; private var available = false; private var foregrounded = false
  private var entry: Entry?
  init(clock: @escaping @Sendable () -> Int64) { uploads = NativeUploadAuthority(clock: clock) }
  func synchronize(_ user: String, epoch: UInt64, available: Bool) -> Bool { lock.withLock {
    guard user.range(of:"^[0-9a-f]{64}$", options:.regularExpression) != nil, epoch <= 9_007_199_254_740_991,
      self.epoch == nil || epoch >= self.epoch!, self.epoch != epoch || self.user == nil || self.user == user else {return false}
    if !available || self.epoch != epoch || self.user != user {cancel()}
    self.user=user; self.epoch=epoch; self.available=available; return true
  }}
  func foreground(_ active: Bool) { lock.withLock {
    foregrounded=active; uploads.setForeground(active); manifests.setForeground(active); if !active {cancel()}
  }}
  func prepare(_ fixture: String, bytes: Data, expectedHash: String, server: String, tags: String) -> Entry? { lock.withLock {
    guard available, foregrounded, let user, let epoch, fixture.range(of:"^[a-z][a-z0-9-]{0,63}$",options:.regularExpression) != nil,
      bytes.count > 0, bytes.count <= 2*1024*1024, Self.hash(bytes) == expectedHash,
      NativeUploadAuthority.validDestination(server), tags.utf8.count <= 32*1024 else {return nil}
    cancel(); let token=UUID().uuidString.lowercased()
    guard let session=uploads.register(token,identity:user) else {return nil}
    uploads.focus(session)
    guard let request=uploads.admit(session,length:bytes.count,destination:server,mimeType:"text/html") else {uploads.revoke(session);return nil}
    for offset in stride(from:0,to:bytes.count,by:NativeUploadAuthority.chunkBytes) {
      guard uploads.append(request,offset:offset,chunk:bytes.subdata(in:offset..<min(bytes.count,offset+NativeUploadAuthority.chunkBytes))) else {uploads.revoke(session);return nil}
    }
    guard let review=uploads.seal(request) else {uploads.revoke(session);return nil}
    let row=Entry(token,fixture,user,server,tags,epoch,session,request,review);entry=row;return row
  }}
  private func lifetime(_ token: String) -> Entry? { lock.withLock {
    guard available, foregrounded, let entry, entry.token == token, entry.identity == user, entry.epoch == epoch,
      entry.verified || uploads.contains(entry.request) else {return nil}; return entry
  }}
  func current(_ token: String) -> Entry? { lock.withLock { guard let row = lifetime(token), row.nativeHandoffManifest == nil else { return nil }; return row } }
  func nativeSigningLifetime(_ token: String, manifest: Bool) -> Bool { lock.withLock {
    guard let row = lifetime(token) else { return false }
    if manifest { guard row.nativeManifestClaimed, let request = row.manifestRequest else { return false }; return manifests.signingLifetime(request) }
    return row.nativeUploadClaimed && uploads.contains(row.request)
  }}
  func pauseNativeSigning(_ token: String, manifest: Bool, paused: Bool) -> Bool { lock.withLock {
    guard let row = lifetime(token), nativeSigningLifetime(token, manifest: manifest),
      paused ? row.nativeHandoffManifest == nil : row.nativeHandoffManifest == manifest else { return false }
    let changed: Bool
    if manifest { guard let request = row.manifestRequest else { return false }; changed = manifests.pauseExecution(request, paused: paused) }
    else { changed = uploads.pauseExecution(row.request, paused: paused) }
    guard changed else { return false }; row.nativeHandoffManifest = paused ? manifest : nil; return true
  }}
  func approveUpload(_ token: String) -> Bool { lock.withLock {
    guard let row=current(token), row.grant == nil, !row.verified, let grant=uploads.approve(row.request,expected:row.review) else {return false}
    row.grant=grant; return uploads.claimSigning(grant) === row.review
  }}
  func uploadApproved(_ token: String) -> Bool { lock.withLock {
    guard let row=current(token), let grant=row.grant else {return false};return uploads.isApproved(grant)
  }}
  func verifyRetrieved(_ token: String, bytes: Data) -> Bool { lock.withLock {
    guard let row=current(token), let grant=row.grant, uploadApproved(token), uploads.wasDispatched(grant),
      bytes.count == row.review.size, Self.hash(bytes) == row.review.sha256 else {return false}
    row.verified=true;uploads.finish(grant);return true
  }}
  func prepareManifest(_ token: String, snapshot: String) -> Bool { lock.withLock {
    guard let row=current(token), row.verified, row.manifestRequest == nil,
      let session=manifests.register(generation:UUID().uuidString.lowercased()) else {return false}
    manifestSession=session; _=manifests.setFocused(session); _=manifests.resumeReview()
    row.manifestRequest=manifests.admit(session,snapshot:snapshot)
    if row.manifestRequest != nil { row.manifestSnapshot = snapshot }
    return row.manifestRequest != nil
  }}
  func approveManifest(_ token: String) -> String? { lock.withLock {
    guard let row=current(token), let request=row.manifestRequest, row.manifestGrant == nil,
      let grant=manifests.approve(request) else {return nil}
    row.manifestGrant=grant;return manifests.take(grant)
  }}
  func manifestApproved(_ token: String) -> Bool { lock.withLock {
    guard let row=current(token), let grant=row.manifestGrant else {return false};return manifests.isApproved(grant)
  }}
  func claimNativeSigning(_ token: String, manifest: Bool) -> Bool { lock.withLock {
    guard let row = current(token) else { return false }
    if manifest {
      guard manifestApproved(token), !row.nativeManifestClaimed else { return false }
      row.nativeManifestClaimed = true
    } else {
      guard uploadApproved(token), !row.nativeUploadClaimed else { return false }
      row.nativeUploadClaimed = true
    }
    return true
  }}
  func cancel() { lock.withLock {
    if let entry {uploads.revoke(entry.session)}
    if let manifestSession {_=manifests.teardown(manifestSession)}
    entry=nil;manifestSession=nil
  }}
  static func hash(_ bytes: Data) -> String { SHA256.hash(data:bytes).map {String(format:"%02x",$0)}.joined() }
}
