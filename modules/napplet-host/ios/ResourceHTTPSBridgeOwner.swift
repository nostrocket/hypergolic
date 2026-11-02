import Foundation
import UIKit

/// Four bounded native resource bodies at most; no resource bytes enter an oversized WebView envelope.
final class ResourceHTTPSBridgeOwner: @unchecked Sendable {
  static let shared = ResourceHTTPSBridgeOwner()
  enum Failure: Error { case policy, invalidRequest, quota, timeout }
  private struct Pending {
    let token: String
    let generation: String
    var continuation: CheckedContinuation<Int, Error>?
    var operation: PublishedPinnedHTTPS.Operation?
    var body: Data?
    var cursor = 0
  }
  private let lock = NSLock()
  private var pending: [String: Pending] = [:]
  private var used: Set<String> = []
  private var foreground = true
  private var observers: [NSObjectProtocol] = []
  private let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "org.nostrocket.hypergolic.resource-lifetime"))

  init() {
    let center = NotificationCenter.default
    for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in self?.setForeground(false) })
    }
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.setForeground(true) })
    timer.schedule(deadline: .now(), repeating: .milliseconds(25))
    timer.setEventHandler { [weak self] in self?.prune() }
    timer.resume()
  }
  deinit { timer.cancel(); for value in observers { NotificationCenter.default.removeObserver(value) }; revokeAll() }

  static func admission(_ token: String) throws -> String {
    guard let snapshot = CapabilityTransport.leases.borrowedSnapshot(token),
      let raw = try JSONSerialization.jsonObject(with: Data(snapshot.utf8)) as? [String: Any],
      let registration = raw["registration"] as? [String: Any],
      let domains = registration["domains"] as? [String], domains.contains("resource"),
      let generation = registration["generation"] as? String,
      let request = raw["request"] as? String,
      let message = try JSONSerialization.jsonObject(with: Data(request.utf8)) as? [String: Any],
      let type = message["type"] as? String, ["resource.bytes", "resource.bytesMany"].contains(type)
    else { throw Failure.policy }
    return generation
  }
  func fetch(_ id: String, token: String, url: String) async throws -> Int {
    guard UUID(uuidString: id)?.uuidString.lowercased() == id, id.dropFirst(14).first == "4" else { throw Failure.invalidRequest }
    let generation = try Self.admission(token)
    return try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      guard foreground, !used.contains(id), used.count < 65_536, pending.count < 4,
            CapabilityTransport.leases.isActive(token) else {
        lock.unlock(); continuation.resume(throwing: Failure.quota); return
      }
      used.insert(id)
      pending[id] = Pending(token: token, generation: generation, continuation: continuation)
      lock.unlock()
      Task { [weak self] in
        guard let self else { return }
        let active = await MainActor.run { UIApplication.shared.applicationState == .active }
        if !active { self.cancel(id); return }
        self.start(id, token: token, url: url)
      }
    }
  }
  private func start(_ id: String, token: String, url: String) {
    guard CapabilityTransport.leases.isActive(token), lock.withLock({ foreground && pending[id] != nil }) else { cancel(id); return }
    do {
      let operation = try PublishedPinnedHTTPS.fetchResource(url) { [weak self] result in self?.complete(id, result: result) }
      let retained = lock.withLock { () -> Bool in
        guard var current = pending[id], current.continuation != nil else { return false }
        current.operation = operation; pending[id] = current; return true
      }
      if !retained { operation.cancel() }
    } catch { complete(id, result: .failure(error)) }
  }
  private func complete(_ id: String, result: Result<PublishedHTTPResponse, Error>) {
    lock.lock()
    guard var current = pending[id], let continuation = current.continuation else { lock.unlock(); return }
    current.continuation = nil
    guard foreground, CapabilityTransport.leases.isActive(current.token) else {
      pending.removeValue(forKey: id); lock.unlock(); continuation.resume(throwing: Failure.timeout); return
    }
    switch result {
    case .success(let response):
      current.body = response.body; current.operation = nil; pending[id] = current
      lock.unlock(); continuation.resume(returning: response.body.count)
    case .failure(let error):
      pending.removeValue(forKey: id); lock.unlock(); continuation.resume(throwing: error)
    }
  }
  func read(_ id: String, token: String, offset: Int) throws -> String {
    try lock.withLock {
      guard foreground, var current = pending[id], current.token == token,
        CapabilityTransport.leases.isActive(token), let body = current.body else { throw Failure.policy }
      guard offset == current.cursor, offset >= 0, offset < body.count else { throw Failure.invalidRequest }
      let end = min(offset + 256 * 1024, body.count)
      let encoded = body.subdata(in: offset..<end).base64EncodedString()
      current.cursor = end
      if end == body.count { pending.removeValue(forKey: id) } else { pending[id] = current }
      return encoded
    }
  }
  func cancel(_ id: String) {
    guard UUID(uuidString: id)?.uuidString.lowercased() == id else { return }
    let current = lock.withLock { () -> Pending? in
      if used.count < 65_536 { used.insert(id) }
      return pending.removeValue(forKey: id)
    }
    current?.operation?.cancel(); current?.continuation?.resume(throwing: Failure.timeout)
  }
  func revoke(_ generation: String) {
    let ids = lock.withLock { pending.filter { $0.value.generation == generation }.map { $0.key } }
    for id in ids { cancel(id) }
  }
  func revokeAll() {
    let all = lock.withLock { let all = Array(pending.values); pending.removeAll(); return all }
    for current in all { current.operation?.cancel(); current.continuation?.resume(throwing: Failure.timeout) }
  }
  private func prune() {
    let ids = lock.withLock { pending.filter { !CapabilityTransport.leases.isActive($0.value.token) }.map { $0.key } }
    for id in ids { cancel(id) }
  }
  private func setForeground(_ value: Bool) { lock.withLock { foreground = value }; if !value { revokeAll() } }
}
