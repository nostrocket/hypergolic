import Foundation

/// Trusted app-only mirror. Revocation invalidates already queued native list replies.
final class IdentityListAccess: @unchecked Sendable {
  struct Owner: Hashable, Sendable {
    let user: String, publisher: String, appId: String
    init(user: String, publisher: String, appId: String) throws {
      guard user.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
        publisher.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
        (1...1024).contains(appId.utf8.count) else {throw Failure.invalid}
      self.user = user; self.publisher = publisher; self.appId = appId
    }
  }
  struct Ticket: Sendable {let owner: Owner; let epoch: UInt64}
  enum Failure: Error {case invalid}
  static let shared = IdentityListAccess()
  private let lock = NSLock()
  private var allowed: Set<Owner> = []
  private var epoch: UInt64 = 0
  func capture(_ owner: Owner) -> Ticket {lock.lock(); defer {lock.unlock()}; return Ticket(owner: owner, epoch: epoch)}
  func permits(_ ticket: Ticket?) -> Bool {
    guard let ticket else {return true}
    lock.lock(); defer {lock.unlock()}; return ticket.epoch == epoch && allowed.contains(ticket.owner)
  }
  func replace(_ owners: [Owner]) throws {
    lock.lock(); defer {lock.unlock()}
    guard epoch < UInt64.max else {allowed = []; throw Failure.invalid}
    let next = Set(owners)
    guard owners.count <= 64, owners.count == next.count else {allowed = []; if epoch < UInt64.max {epoch += 1}; throw Failure.invalid}
    if !allowed.isSubset(of: next) {guard epoch < UInt64.max else {allowed = []; throw Failure.invalid}; epoch += 1}
    allowed = next
  }
  func clear() {lock.lock(); defer {lock.unlock()}; allowed = []; if epoch < UInt64.max {epoch += 1}}
}
