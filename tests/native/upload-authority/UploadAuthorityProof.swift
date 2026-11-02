import Foundation

/// Actual Swift owner logic with a controlled native clock; no system UI/network claim.
final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int64 = 100
  func now() -> Int64 { lock.withLock { value } }
  func advance(_ amount: Int64) { lock.withLock { value += amount } }
}
@main struct UploadAuthorityProof {
  static func main() {
    var checks = 0
    func check(_ value: @autoclosure () -> Bool) { checks += 1; precondition(value(), "Check \(checks)") }
    let identity = String(repeating: "a", count: 64), server = "https://files.example.com", body = Data([1,2,3])
    let time = Clock(), owner = NativeUploadAuthority(clock: { time.now() })
    let a = owner.register("a", identity: identity)!, b = owner.register("b", identity: String(repeating: "b", count: 64))!, c = owner.register("c", identity: identity)!
    check(owner.register("a", identity: identity) == nil); check(owner.register("bad", identity: "not-a-key") == nil)
    check(owner.admit(a, length: 3, destination: server, mimeType: "image/png") == nil)
    owner.setForeground(true); owner.focus(a)
    for destination in ["http://files.example.com", "https://localhost", "https://127.0.0.1", "https://2130706433",
      "https://files.example.com/upload", "https://files.example.com/", "https://files.example.com:443", "https://FILES.example.com",
      "https://files.example.com?x=y", "https://user@files.example.com", "https://files.example.com#secret", "https://files.example.com:0",
      "https://files.example.com:65536", "https://files.example.com:\n"] {
      check(owner.admit(a, length: 3, destination: destination, mimeType: "image/png") == nil)
    }
    check(owner.admit(a, length: NativeUploadAuthority.maxBytes + 1, destination: server, mimeType: "image/png") == nil)
    check(owner.admit(a, length: 3, destination: server, mimeType: "image/png; charset=x") == nil)
    let request = owner.admit(a, length: 3, destination: server, mimeType: "image/png")!
    check(owner.seal(request) == nil); check(owner.admit(a, length: 1, destination: server, mimeType: "image/png") == nil)
    check(!owner.append(request, offset: 1, chunk: body)); check(!owner.append(request, offset: 0, chunk: Data([1,2,3,4])))
    var input = body; check(owner.append(request, offset: 0, chunk: input)); input[0] = 99
    check(!owner.append(request, offset: 0, chunk: body)); let review = owner.seal(request)!
    check(review.sha256 == "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81")
    check(review.identity == identity && review.size == 3 && review.destination == server && review.purpose == "blossom-upload")
    check(owner.seal(request) == nil); check(!owner.append(request, offset: 0, chunk: body))
    var preview = owner.preview(request, expected: review)!; check(preview == body); preview[0] = 88
    check(owner.preview(request, expected: review) == body)
    let other = owner.admit(b, length: 1, destination: server, mimeType: "text/plain")!
    let third = owner.admit(c, length: 1, destination: server, mimeType: "text/plain"); check(third != nil); owner.cancel(third!)
    check(owner.append(other, offset: 0, chunk: Data([4]))); let otherReview = owner.seal(other)!
    check(!owner.mayReview(other, expected: otherReview)); check(owner.approve(request, expected: otherReview) == nil)
    owner.focus(b); check(owner.approve(request, expected: review) == nil); check(owner.preview(request, expected: review) == nil)
    owner.focus(a); check(!owner.clearFocus(b)); check(owner.mayReview(request, expected: review))
    let grant = owner.approve(request, expected: review)!
    check(owner.approve(request, expected: review) == nil); check(owner.dispatch(grant) == nil); check(!owner.wasDispatched(grant))
    check(owner.claimSigning(grant) === review); check(owner.claimSigning(grant) == nil)
    check(owner.dispatch(grant) == nil); check(owner.claimTransfer(grant)); check(!owner.claimTransfer(grant))
    owner.focus(b); check(owner.isApproved(grant)); check(owner.clearFocus(b)); check(owner.isApproved(grant))
    var sent = owner.dispatch(grant)!; check(sent == body); sent[0] = 77
    check(owner.wasDispatched(grant)); check(owner.dispatch(grant) == nil)
    owner.cancel(request); check(!owner.isApproved(grant)); check(owner.dispatch(grant) == nil); check(owner.wasDispatched(grant)); owner.cancel(other)
    let staged = owner.admit(a, length: 3, destination: server, mimeType: "image/png")!
    owner.setForeground(false); owner.setForeground(true); check(!owner.append(staged, offset: 0, chunk: body))
    owner.focus(a); let background = owner.admit(a, length: 3, destination: server, mimeType: "image/png")!
    check(owner.append(background, offset: 0, chunk: body)); let backgroundReview = owner.seal(background)!
    let backgroundGrant = owner.approve(background, expected: backgroundReview)!
    owner.setForeground(false); owner.setForeground(true); check(!owner.isApproved(backgroundGrant))
    check(owner.claimSigning(backgroundGrant) == nil); check(!owner.wasDispatched(backgroundGrant))
    owner.focus(a); let expired = owner.admit(a, length: 3, destination: server, mimeType: "image/png")!
    check(owner.append(expired, offset: 0, chunk: body)); let expiredReview = owner.seal(expired)!
    let expiredGrant = owner.approve(expired, expected: expiredReview)!
    time.advance(60_000); check(!owner.isApproved(expiredGrant)); check(owner.claimSigning(expiredGrant) == nil)
    let stale = owner.admit(a, length: 3, destination: server, mimeType: "image/png")!
    owner.revoke(a); check(owner.append(stale, offset: 0, chunk: body) == false)
    let replacement = owner.register("a", identity: identity)!
    check(owner.admit(a, length: 0, destination: server, mimeType: "text/plain") == nil)
    owner.focus(replacement); let empty = owner.admit(replacement, length: 0, destination: server, mimeType: "text/plain")!
    let emptyReview = owner.seal(empty)!
    check(emptyReview.sha256 == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"); owner.cancel(empty)
    let longReview = owner.admit(replacement, length: 0, destination: server, mimeType: "text/plain")!
    time.advance(600_000); check(owner.seal(longReview) == nil)
    let rollback = owner.admit(replacement, length: 0, destination: server, mimeType: "text/plain")!
    time.advance(-1); check(owner.seal(rollback) == nil)
    check(owner.admit(replacement, length: 0, destination: server, mimeType: "text/plain") == nil)
    owner.revokeAll(); check(owner.register("after-clock-failure", identity: identity) == nil)
    print("{\"language\":\"Swift\",\"uploadAuthorityChecks\":\(checks),\"failed\":0}")
  }
}
