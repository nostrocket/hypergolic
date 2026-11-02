import Foundation
import UIKit

/// Owns cancellable native reads; no WebView or publisher-supplied object receives this owner.
final class PublishedHTTPSBridgeOwner: @unchecked Sendable {
  enum Failure: Error { case invalidOperation, busy, inactive }

  private struct Pending {
    let continuation: CheckedContinuation<String, Error>
    var operation: PublishedPinnedHTTPS.Operation?
  }

  private let lock = NSLock()
  private var pending: [String: Pending] = [:]
  // Expo may deliver a synchronous cancel before its queued async fetch begins.
  private var cancelledBeforeStart: Set<String> = []
  private var cancellationBudgetExhausted = false
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
    guard UUID(uuidString: operationId)?.uuidString.lowercased() == operationId else { throw Failure.invalidOperation }
    return try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      let preCancelled = cancelledBeforeStart.remove(operationId) != nil
      guard !preCancelled, !cancellationBudgetExhausted, foreground, pending.count < 4,
            pending[operationId] == nil else {
        lock.unlock()
        continuation.resume(throwing: Failure.busy)
        return
      }
      pending[operationId] = Pending(continuation: continuation, operation: nil)
      lock.unlock()
      Task {
        let active = await MainActor.run { UIApplication.shared.applicationState == .active }
        if active { self.startOperation(operationId: operationId, url: url) }
        else { self.complete(operationId: operationId, result: .failure(Failure.inactive)) }
      }
    }
  }

  private func startOperation(operationId: String, url: String) {
    lock.lock()
    let allowed = foreground && pending[operationId] != nil
    lock.unlock()
    guard allowed else { return }
    do {
      let operation = try PublishedPinnedHTTPS.fetch(url, maximumBodyBytes: PublishedHTTPResponse.maximumBodyBytes) { [weak self] result in
        self?.complete(operationId: operationId, result: result)
      }
      lock.lock()
      if var current = pending[operationId] {
        current.operation = operation
        pending[operationId] = current
        lock.unlock()
      } else {
        lock.unlock()
        operation.cancel()
      }
    } catch { complete(operationId: operationId, result: .failure(error)) }
  }

  func cancel(operationId: String) {
    guard UUID(uuidString: operationId)?.uuidString.lowercased() == operationId else { return }
    lock.lock()
    let current = pending.removeValue(forKey: operationId)
    if current == nil {
      if cancelledBeforeStart.count < 4_096 { cancelledBeforeStart.insert(operationId) }
      else { cancellationBudgetExhausted = true }
    }
    lock.unlock()
    current?.operation?.cancel()
    current?.continuation.resume(throwing: Failure.inactive)
  }

  func revokeAll() {
    lock.lock()
    let all = Array(pending.values)
    pending.removeAll()
    lock.unlock()
    for current in all {
      current.operation?.cancel()
      current.continuation.resume(throwing: Failure.inactive)
    }
  }

  private func setForeground(_ value: Bool) {
    lock.lock()
    foreground = value
    lock.unlock()
    if !value { revokeAll() }
  }

  private func complete(operationId: String, result: Result<PublishedHTTPResponse, Error>) {
    lock.lock()
    let current = pending.removeValue(forKey: operationId)
    lock.unlock()
    guard let current else { return }
    switch result {
    case .success(let response): current.continuation.resume(returning: response.body.base64EncodedString())
    case .failure(let error): current.continuation.resume(throwing: error)
    }
  }
}
