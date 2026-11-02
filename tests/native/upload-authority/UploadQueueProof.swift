import Foundation
@main struct Proof {
  static func main() {
    var checks = 0
    func check(_ value: Bool) { checks += 1; precondition(value, "Queue check \(checks)") }
    let owner = NativeUploadAuthority(clock: {1}); owner.setForeground(true)
    var sessions: [NativeUploadAuthority.Session] = [], requests: [NativeUploadAuthority.Request] = [], reviews: [NativeUploadAuthority.Review] = []
    for index in 0..<12 { let session = owner.register("realm\(index)", identity: String(repeating: "a", count: 64)); check(session != nil); sessions.append(session!) }
    for index in 0..<8 { let request = owner.admit(sessions[index], length: 0, destination: "https://files.example.com", mimeType: "text/plain"); check(request != nil); requests.append(request!); let review = owner.seal(request!); check(review != nil); reviews.append(review!) }
    check(owner.admit(sessions[8], length: 0, destination: "https://files.example.com", mimeType: "text/plain") == nil)
    check(owner.admit(sessions[0], length: 0, destination: "https://files.example.com", mimeType: "text/plain") == nil)
    owner.focus(sessions[0]); let first = owner.approve(requests[0], expected: reviews[0]); check(first != nil)
    owner.focus(sessions[1]); let second = owner.approve(requests[1], expected: reviews[1]); check(second != nil)
    owner.focus(sessions[2]); check(owner.approve(requests[2], expected: reviews[2]) == nil); check(owner.contains(requests[2]))
    for index in 8..<10 { let request = owner.admit(sessions[index], length: 0, destination: "https://files.example.com", mimeType: "text/plain"); check(request != nil); requests.append(request!); let review = owner.seal(request!); check(review != nil); reviews.append(review!) }
    check(owner.admit(sessions[10], length: 0, destination: "https://files.example.com", mimeType: "text/plain") == nil)
    owner.cancelGrant(first!); check(owner.approve(requests[2], expected: reviews[2]) != nil)
    check(owner.admit(sessions[10], length: 0, destination: "https://files.example.com", mimeType: "text/plain") != nil)
    check(owner.admit(sessions[11], length: 0, destination: "https://files.example.com", mimeType: "text/plain") == nil)
    owner.setForeground(false); check(!owner.isApproved(second!)); owner.setForeground(true)
    check(owner.admit(sessions[0], length: 0, destination: "https://files.example.com", mimeType: "text/plain") != nil); check(!owner.isApproved(second!))
    print("{\"language\":\"Swift\",\"uploadQueueChecks\":\(checks),\"failed\":0,\"scope\":\"native authority; eight pending and two approved slots, no app journey proof\"}")
  }
}
