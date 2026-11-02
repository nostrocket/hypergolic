import Foundation
@main struct Proof {
  static func main() throws {
    var count = 0
    func check(_ value: Bool) {precondition(value, "check \(count)"); count += 1}
    func owner(_ app: String) throws -> IdentityListAccess.Owner {try .init(user: String(repeating: "1", count: 64), publisher: String(repeating: "2", count: 64), appId: app)}
    func rejects(_ action: () throws -> Void) {do {try action(); preconditionFailure("accepted invalid input")} catch {count += 1}}
    let policy = IdentityListAccess(), a = try owner("A"), b = try owner("B"), pending = policy.capture(a)
    check(!policy.permits(pending)); try policy.replace([a]); check(policy.permits(pending)); check(!policy.permits(policy.capture(b)))
    try policy.replace([a,b]); check(policy.permits(pending)); let oldB = policy.capture(b); check(policy.permits(oldB))
    let foreignUser = try IdentityListAccess.Owner(user: String(repeating: "3", count: 64), publisher: a.publisher, appId: a.appId)
    let foreignPublisher = try IdentityListAccess.Owner(user: a.user, publisher: String(repeating: "3", count: 64), appId: a.appId)
    check(!policy.permits(policy.capture(foreignUser))); check(!policy.permits(policy.capture(foreignPublisher))); check(!policy.permits(policy.capture(try owner("A\0B"))))
    try policy.replace([b]); check(!policy.permits(pending)); check(!policy.permits(oldB))
    try policy.replace([a,b]); check(!policy.permits(pending)); let fresh = policy.capture(a); check(policy.permits(fresh)); check(policy.permits(policy.capture(b)))
    rejects {try policy.replace([a,a])}; check(!policy.permits(fresh)); try policy.replace([a]); check(!policy.permits(fresh))
    let latest = policy.capture(a); check(policy.permits(latest)); policy.clear(); check(!policy.permits(latest))
    rejects {_ = try owner("")}; rejects {_ = try owner(String(repeating: "雪", count: 342))}; check(try owner(String(repeating: "雪", count: 341)).appId.count == 341)
    rejects {_ = try IdentityListAccess.Owner(user: String(repeating: "A", count: 64), publisher: a.publisher, appId: "app")}
    rejects {try policy.replace(try (0..<65).map {try owner("app-\($0)")})}
    try policy.replace([a]); let raced = policy.capture(a); let group = DispatchGroup(); group.enter()
    DispatchQueue.global().async {policy.clear(); group.leave()}; group.wait(); check(!policy.permits(raced))
    print("PASS native identity-list Swift \(count) checks")
  }
}
