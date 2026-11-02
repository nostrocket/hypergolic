import Foundation

@main struct NativePermitProof {
  static func main() {
    var checks = 0
    func check(_ value: @autoclosure () -> Bool) { checks += 1; precondition(value(), "Check \(checks)") }
    let tokens = Array(CommandLine.arguments.dropFirst()), authority = NativeUploadAuthority(clock: {100})
    let session = authority.register("fixture", identity: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")!
    authority.setForeground(true); authority.focus(session)
    let request = authority.admit(session, length: 3, destination: "https://files.example.com", mimeType: "image/png")!
    check(authority.append(request, offset: 0, chunk: Data([1,2,3]))); let review = authority.seal(request)!
    let permit = NativeBlossomPermit.capture(review, token: tokens[0], now: 1001)!
    check(permit.review === review); check(permit.authorization == "Nostr " + tokens[0]); check(permit.expiration == 1120)
    check(permit.validAt(1001)); check(permit.validAt(1119))
    for now: Int64 in [999,1000,1120,-1,Int64.max] { check(!permit.validAt(now)) }
    for token in tokens.dropFirst() { check(NativeBlossomPermit.capture(review, token: token, now: 1001) == nil) }
    for now: Int64 in [999,1000,1120,-1,Int64.max] { check(NativeBlossomPermit.capture(review, token: tokens[0], now: now) == nil) }
    check(NativeBlossomPermit.capture(review, token: tokens[0]+"=", now: 1001) == nil)
    check(NativeBlossomPermit.capture(review, token: tokens[0]+"\r\nForged: yes", now: 1001) == nil)
    check(NativeBlossomPermit.capture(review, token: String(repeating: "a", count: 4097), now: 1001) == nil)
    let grant = authority.approve(request, expected: review)!
    check(authority.approvedReview(grant) === review)
    authority.setForeground(false); authority.setForeground(true); check(authority.approvedReview(grant) == nil)
    print("{\"language\":\"Swift\",\"uploadPermitChecks\":\(checks),\"failed\":0}")
  }
}
