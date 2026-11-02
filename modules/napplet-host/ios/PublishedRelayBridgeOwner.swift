import Foundation
import UIKit

/// App-only owner for bounded relay reads. No napplet WebView receives this bridge.
final class PublishedRelayBridgeOwner: @unchecked Sendable {
  enum Failure: Error { case invalidOperation, invalidRequest, busy, inactive }

  private struct Pending {
    let continuation: CheckedContinuation<[String], Error>
    var operation: PublishedRelayWebSocketQuery.Operation?
  }

  private let lock = NSLock()
  private var pending: [String: Pending] = [:]
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

  func query(operationId: String, url: String, requestText: String, subscriptionId: String) async throws -> [String] {
    guard UUID(uuidString: operationId)?.uuidString.lowercased() == operationId else { throw Failure.invalidOperation }
    guard Self.validRequest(requestText, subscriptionId: subscriptionId) else { throw Failure.invalidRequest }
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
        if active { self.startOperation(operationId: operationId, url: url, requestText: requestText, subscriptionId: subscriptionId) }
        else { self.complete(operationId: operationId, result: .failure(Failure.inactive)) }
      }
    }
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

  private func startOperation(operationId: String, url: String, requestText: String, subscriptionId: String) {
    lock.lock()
    let allowed = foreground && pending[operationId] != nil
    lock.unlock()
    guard allowed else { return }
    do {
      let operation = try PublishedRelayWebSocketQuery.query(url, subscription: requestText, classifyText: { text in
        PublishedRelayEnvelope.classify(text, subscriptionId: subscriptionId)
      }) { [weak self] result in
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

  private func complete(operationId: String, result: Result<[String], Error>) {
    lock.lock()
    let isForeground = foreground
    let current = pending.removeValue(forKey: operationId)
    lock.unlock()
    guard let current else { return }
    guard isForeground else { current.continuation.resume(throwing: Failure.inactive); return }
    switch result {
    case .success(let envelopes): current.continuation.resume(returning: envelopes)
    case .failure(let error): current.continuation.resume(throwing: error)
    }
  }

  private static func validRequest(_ text: String, subscriptionId: String) -> Bool {
    guard !subscriptionId.isEmpty, subscriptionId.utf8.count <= 64,
          subscriptionId.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7e }),
          text.utf8.count <= PublishedRelayWebSocketClientFrames.maxTextBytes,
          let data = text.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data), let message = value as? [Any],
          message.count >= 3, message[0] as? String == "REQ", message[1] as? String == subscriptionId else { return false }
    return message.dropFirst(2).allSatisfy { $0 is [String: Any] }
  }
}
