import Foundation

/// Only an already committed handoff receipt survives background; never generation revocation.
final class LinkLeaseRegistry: @unchecked Sendable {
  private struct Session {let user: String; let epoch: UInt64; var focused = false; var attempts: [UInt64] = []}
  private struct Entry {let generation: String; let expires: UInt64; var dispatched = false}
  private let lock = NSLock()
  private let clock: @Sendable () -> UInt64
  private var sessions: [String: Session] = [:]
  private var requests: [String: Entry] = [:]
  private var global: [UInt64] = []
  private var foreground = false
  private var owner: String?
  private var epoch: UInt64 = 0
  private var available = false
  init(clock: @escaping @Sendable () -> UInt64 = {DispatchTime.now().uptimeNanoseconds / 1_000_000}) {self.clock = clock}
  private func locked<T>(_ action: () -> T) -> T {lock.lock(); defer {lock.unlock()}; return action()}
  private func owns(_ s: Session) -> Bool {available && owner == s.user && epoch == s.epoch}
  func synchronizeOwner(_ user: String, epoch next: UInt64, available ready: Bool) -> [String]? {locked {
    guard owner == nil || next > epoch || next == epoch && owner == user else {return nil}
    let changed = owner != user || epoch != next
    owner = user; epoch = next; available = ready
    let tokens = !ready || changed ? cancel(nil, true) : []
    if changed {sessions = sessions.filter {$0.value.user == user && $0.value.epoch == next}}
    return tokens
  }}
  func register(_ generation: String, user: String, epoch: UInt64) -> Bool {locked {
    if let s = sessions[generation] {return s.user == user && s.epoch == epoch}
    guard sessions.count < 64 else {return false}; sessions[generation] = Session(user: user, epoch: epoch); return true
  }}
  func canDeliver(_ generation: String) -> Bool {locked {sessions[generation].map {owns($0)} ?? false}}
  func admit(_ generation: String) -> String? {locked {
    let now = clock()
    guard foreground, var s = sessions[generation], owns(s), s.focused else {return nil}
    s.attempts.removeAll {now >= $0 && now - $0 >= 60_000}; global.removeAll {now >= $0 && now - $0 >= 60_000}
    guard requests.isEmpty, s.attempts.count < 3, global.count < 12 else {return nil}
    s.attempts.append(now); sessions[generation] = s; global.append(now)
    let token = UUID().uuidString.lowercased(); requests[token] = Entry(generation: generation, expires: now + 25_000); return token
  }}
  func claim(_ token: String) -> Bool {locked {
    guard var e = requests[token], let s = sessions[e.generation], owns(s), !e.dispatched,
      clock() < e.expires, foreground, s.focused else {return false}
    e.dispatched = true; requests[token] = e; return true
  }}
  func finish(_ token: String) -> Bool {locked {
    guard let e = requests.removeValue(forKey: token), let s = sessions[e.generation], owns(s), clock() < e.expires else {return false}
    return e.dispatched || foreground && s.focused
  }}
  func focus(_ generation: String, _ value: Bool) -> [String] {locked {
    sessions[generation]?.focused = value; return value ? [] : cancel(generation, false)
  }}
  func setForeground(_ value: Bool) -> [String] {locked {foreground = value; return value ? [] : cancel(nil, false)}}
  func revoke(_ generation: String) -> [String] {locked {sessions.removeValue(forKey: generation); return cancel(generation, true)}}
  func expire() -> [String] {locked {
    let now = clock(), tokens = requests.filter {now >= $0.value.expires}.map { $0.key }
    for token in tokens {requests.removeValue(forKey: token)}; return tokens
  }}
  private func cancel(_ generation: String?, _ all: Bool) -> [String] {
    let tokens = requests.filter {(generation == nil || generation == $0.value.generation) && (all || !$0.value.dispatched)}.map {$0.key}
    for token in tokens {requests.removeValue(forKey: token)}; return tokens
  }
}
