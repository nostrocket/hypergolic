import Foundation

/// Synchronous native routing authority, independent of React lifecycle/event timing.
final class RoutingEndpointRegistry: @unchecked Sendable {
  private static let max: UInt64 = 9_007_199_254_740_991
  private struct Endpoint {
    let user: String; let epoch: UInt64; let intent: Bool; let inc: Bool; let notify: Bool; let config: Bool
    var ready = false; var focused = false; var reviewRevision: UInt64 = 0
  }
  private let lock = NSLock()
  private var endpoints: [String: Endpoint] = [:]
  private var ownerUser = ""
  private var ownerEpoch: UInt64?
  private var ownerAvailable = false
  private var foreground = true
  private var counter: UInt64 = 0
  @discardableResult func synchronizeOwner(_ user: String, epoch: UInt64, available: Bool) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard user.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      epoch <= Self.max, counter < Self.max,
      ownerEpoch == nil || epoch >= ownerEpoch!,
      ownerEpoch != epoch || ownerUser == user else { return false }
    if ownerUser != user || ownerEpoch != epoch || ownerAvailable != available { counter += 1 }
    ownerUser = user; ownerEpoch = epoch; ownerAvailable = available; return true
  }
  func setForeground(_ value: Bool) {
    lock.lock(); defer { lock.unlock() }
    if value != foreground { if counter < Self.max { counter += 1 } else { ownerAvailable = false } }
    foreground = value
  }
  func register(_ generation: String, user: String, epoch: UInt64, intent: Bool, inc: Bool, notify: Bool = false, config: Bool = false) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard counter < Self.max, generation.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
      ownerAvailable, user == ownerUser, epoch == ownerEpoch, intent || inc || notify || config, endpoints[generation] == nil,
      endpoints.count < 64 else { return false }
    endpoints[generation] = Endpoint(user: user, epoch: epoch, intent: intent, inc: inc, notify: notify, config: config); return true
  }
  func ready(_ generation: String) { lock.lock(); defer { lock.unlock() }; endpoints[generation]?.ready = true }
  @discardableResult func focus(_ generation: String, _ value: Bool) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard var endpoint = endpoints[generation], endpoint.focused != value else { return false }
    if endpoint.reviewRevision < Self.max { endpoint.reviewRevision += 1 }; endpoint.focused = value; endpoints[generation] = endpoint; return true
  }
  func revoke(_ generation: String) { lock.lock(); defer { lock.unlock() }; endpoints.removeValue(forKey: generation) }
  private func active(_ generation: String) -> Bool {
    guard let endpoint = endpoints[generation] else { return false }
    return counter < Self.max && foreground && ownerAvailable && endpoint.ready && endpoint.epoch == ownerEpoch && endpoint.user == ownerUser
  }
  func mayDeliver(_ generation: String, domain: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard active(generation), let endpoint = endpoints[generation] else { return false }
    return (domain == "intent" && endpoint.intent) || (domain == "inc" && endpoint.inc) || (domain == "notify" && endpoint.notify) || (domain == "config" && endpoint.config)
  }
  func mayReview(_ generation: String) -> Bool { lock.lock(); defer { lock.unlock() }; return active(generation) && endpoints[generation]!.focused && endpoints[generation]!.reviewRevision < Self.max }
  func reviewRevision(_ generation: String) -> Int64 {
    lock.lock(); defer { lock.unlock() }
    guard active(generation), let endpoint = endpoints[generation], endpoint.focused, endpoint.reviewRevision < Self.max else { return -1 }
    return Int64(endpoint.reviewRevision)
  }
  func matchesRevision(_ value: UInt64) -> Bool { lock.lock(); defer { lock.unlock() }; return value == counter && counter < Self.max && foreground && ownerAvailable }
  func state() -> (user: String, epoch: UInt64?, revision: UInt64, available: Bool, ownerAvailable: Bool, foreground: Bool) {
    lock.lock(); defer { lock.unlock() }; return (ownerUser, ownerEpoch, counter, foreground && ownerAvailable && counter < Self.max, ownerAvailable, foreground)
  }
}
