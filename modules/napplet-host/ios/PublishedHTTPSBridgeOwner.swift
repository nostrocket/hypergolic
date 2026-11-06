import Foundation
import UIKit

/// Owns cancellable native reads; no WebView or publisher-supplied object receives this owner.
final class PublishedHTTPSBridgeOwner: @unchecked Sendable {
  enum Failure: Error { case invalidOperation, busy, inactive }
  private static let artifactChunkBytes = 48 * 1024
  private static let maximumReservedBodyBytes = 32 * 1024 * 1024

  private enum Reply {
    case avatar(CheckedContinuation<String, Error>)
    case artifact(CheckedContinuation<Int, Error>)

    var isArtifact: Bool { if case .artifact = self { return true }; return false }
    var maximumBytes: Int {
      isArtifact ? PublishedHTTPResponse.maximumArtifactBodyBytes : PublishedHTTPResponse.maximumBodyBytes
    }
    func reject(_ error: Error) {
      switch self {
      case .avatar(let continuation): continuation.resume(throwing: error)
      case .artifact(let continuation): continuation.resume(throwing: error)
      }
    }
  }

  private struct Pending {
    let reply: Reply
    var operation: PublishedPinnedHTTPS.Operation?
    var starting = false
    var cancelled = false
  }
  private struct Ready {
    let body: Data
    var cursor = 0
  }

  private let lock = NSLock()
  private var pending: [String: Pending] = [:]
  private var ready: [String: Ready] = [:]
  // Consume ids on start or early cancellation. Completed and cancelled reads cannot be replayed.
  private var used: Set<String> = []
  private var foreground = true
  private var observers: [NSObjectProtocol] = []

  init() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: nil) { [weak self] _ in
      self?.setForeground(false)
    })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.setForeground(false)
    })
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in
      self?.setForeground(true)
    })
  }

  deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    revokeAll()
  }

  func fetch(operationId: String, url: String) async throws -> String {
    try await withCheckedThrowingContinuation { start(operationId: operationId, url: url, reply: .avatar($0)) }
  }

  func fetchArtifact(operationId: String, url: String) async throws -> Int {
    try await withCheckedThrowingContinuation { start(operationId: operationId, url: url, reply: .artifact($0)) }
  }

  private func start(operationId: String, url: String, reply: Reply) {
    guard UUID(uuidString: operationId)?.uuidString.lowercased() == operationId else {
      reply.reject(Failure.invalidOperation)
      return
    }
    let admitted = lock.withLock {
      let reserved = ready.values.reduce(reply.maximumBytes) { $0 + $1.body.count } +
        pending.values.reduce(0) { $0 + $1.reply.maximumBytes }
      guard foreground, reserved <= Self.maximumReservedBodyBytes,
            pending.count + ready.count < 4, used.count < 65_536,
            used.insert(operationId).inserted else { return false }
      pending[operationId] = Pending(reply: reply)
      return true
    }
    guard admitted else { reply.reject(Failure.busy); return }
    Task {
      let active = await MainActor.run { UIApplication.shared.applicationState == .active }
      if active { self.startOperation(operationId: operationId, url: url) }
      else { self.complete(operationId: operationId, result: .failure(Failure.inactive)) }
    }
  }

  private func startOperation(operationId: String, url: String) {
    let artifact = lock.withLock { () -> Bool? in
      guard foreground, var current = pending[operationId], !current.cancelled else { return nil }
      current.starting = true
      pending[operationId] = current
      return current.reply.isArtifact
    }
    guard let isArtifact = artifact else { return }
    let completion: @Sendable (Result<PublishedHTTPResponse, Error>) -> Void = { [weak self] result in
      self?.complete(operationId: operationId, result: result)
    }
    do {
      let operation = try isArtifact ? PublishedPinnedHTTPS.fetchArtifact(url, completion: completion) :
        PublishedPinnedHTTPS.fetch(url, maximumBodyBytes: PublishedHTTPResponse.maximumBodyBytes, completion: completion)
      let retained = lock.withLock {
        guard var current = pending[operationId] else { return false }
        current.operation = operation
        pending[operationId] = current
        return !current.cancelled
      }
      if !retained { operation.cancel() }
    } catch { complete(operationId: operationId, result: .failure(error)) }
  }

  func readArtifactChunk(operationId: String, offset: Int) throws -> String {
    try lock.withLock {
      guard foreground, var current = ready[operationId], current.cursor == offset,
            offset >= 0, offset < current.body.count else { throw Failure.invalidOperation }
      let end = min(offset + Self.artifactChunkBytes, current.body.count)
      let encoded = current.body.subdata(in: offset..<end).base64EncodedString()
      current.cursor = end
      if end == current.body.count { ready.removeValue(forKey: operationId) }
      else { ready[operationId] = current }
      return encoded
    }
  }

  func cancel(operationId: String) {
    guard UUID(uuidString: operationId)?.uuidString.lowercased() == operationId else { return }
    let current = lock.withLock {
      if used.count < 65_536 { used.insert(operationId) }
      ready.removeValue(forKey: operationId)
      return cancelLocked(operationId)
    }
    current?.operation?.cancel()
    current?.reply.reject(Failure.inactive)
  }

  func revokeAll() {
    let all = lock.withLock {
      ready.removeAll()
      return Array(pending.keys).compactMap { cancelLocked($0) }
    }
    for current in all {
      current.operation?.cancel()
      current.reply.reject(Failure.inactive)
    }
  }

  // Keep an in-flight reservation until its network callback releases the accumulator.
  private func cancelLocked(_ operationId: String) -> Pending? {
    guard var current = pending[operationId], !current.cancelled else { return nil }
    if current.starting {
      current.cancelled = true
      pending[operationId] = current
    } else {
      pending.removeValue(forKey: operationId)
    }
    return current
  }

  private func setForeground(_ value: Bool) {
    lock.withLock { foreground = value }
    if !value { revokeAll() }
  }

  private func complete(operationId: String, result: Result<PublishedHTTPResponse, Error>) {
    lock.lock()
    guard let current = pending.removeValue(forKey: operationId), !current.cancelled else { lock.unlock(); return }
    guard foreground else { lock.unlock(); current.reply.reject(Failure.inactive); return }
    switch (current.reply, result) {
    case (.artifact(let continuation), .success(let response)):
      guard !response.body.isEmpty else { lock.unlock(); continuation.resume(throwing: Failure.invalidOperation); return }
      ready[operationId] = Ready(body: response.body)
      lock.unlock()
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 15) { [weak self] in
        self?.discardArtifact(operationId)
      }
      continuation.resume(returning: response.body.count)
    case (.avatar(let continuation), .success(let response)):
      lock.unlock()
      continuation.resume(returning: response.body.base64EncodedString())
    case (_, .failure(let error)):
      lock.unlock()
      current.reply.reject(error)
    }
  }

  private func discardArtifact(_ operationId: String) {
    lock.withLock { _ = ready.removeValue(forKey: operationId) }
  }
}
