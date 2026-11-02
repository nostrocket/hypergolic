import Foundation
import CoreFoundation

/// App-only, bounded native EVENT owner. Read-query bridges remain read-only.
final class OutboxPublicationOwner: @unchecked Sendable {
  static let shared = OutboxPublicationOwner()
  private let lock = NSLock()
  private var active = 0
#if HYPERGOLIC_NETWORK_PROOF
  /// Only separate native QA builds may select a controlled endpoint or trust anchor.
  struct ProofTarget: Sendable {
    let url: String
    let addresses: [PublishedPinnedHTTPS.Address]
    let anchorDER: Data
    let beforeSend: @Sendable () -> Void
    var onFailure: (@Sendable (String) -> Void)? = nil
  }
  private let proofTarget: ProofTarget?
  init(proofTarget: ProofTarget? = nil) { self.proofTarget = proofTarget }
#endif

  func publish(token: String, group: String, event: String, relay: String) async throws -> String {
    let send = try ApprovalTransport.registry.reserveOutbox(token, group: group, wire: event, relay: relay)
    guard lock.withLock({ if active >= 4 { return false }; active += 1; return true }) else {
      return try Self.receipt(send, status: "cancelled-before-send", reason: "publication capacity unavailable")
    }
    defer { lock.withLock { active -= 1 } }
    let run = Run(token: token, send: send)
#if HYPERGOLIC_NETWORK_PROOF
    run.proofTarget = proofTarget
#endif
    return await withTaskCancellationHandler {
      await run.execute()
    } onCancel: { run.cancel() }
  }
  private static func receipt(_ send: NativeOutboxPlan.Send, status: String, reason: String) throws -> String {
    let value = ["relay": send.relay, "eventId": send.eventId, "status": status, "reason": reason]
    return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
  }
  private final class Run: @unchecked Sendable {
    let token: String
    let send: NativeOutboxPlan.Send
    let acknowledgement: OutboxAcknowledgement
    private let lock = NSLock()
    private var operation: PublishedRelayWebSocketQuery.Operation?
    private var continuation: CheckedContinuation<String, Never>?
    private var timer: DispatchSourceTimer?
    private var ended = false
    private var cancelled = false
#if HYPERGOLIC_NETWORK_PROOF
    fileprivate var proofTarget: ProofTarget?
#endif
    init(token: String, send: NativeOutboxPlan.Send) { self.token = token; self.send = send; acknowledgement = OutboxAcknowledgement(send.eventId) }
    func mayContinue() -> Bool {
      !lock.withLock { cancelled || ended } && ContinuousClock.now < send.deadline && ApprovalTransport.isApproved(token)
    }
    func execute() async -> String {
      await withCheckedContinuation { continuation in
        lock.withLock { self.continuation = continuation }
        guard mayContinue() else { complete(.failure(NativeOutboxPlan.Failure.revoked)); return }
        do {
          let operation = try makeOperation()
          let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
          timer.schedule(deadline: .now(), repeating: .milliseconds(20))
          timer.setEventHandler { if !self.mayContinue() { self.cancel() } }
          let stop = lock.withLock { if ended || cancelled { return true }; self.operation = operation; self.timer = timer; return false }
          timer.resume()
          if stop { timer.cancel(); operation.cancel() }
        } catch { complete(.failure(error)) }
      }
    }
    private func makeOperation() throws -> PublishedRelayWebSocketQuery.Operation {
#if HYPERGOLIC_NETWORK_PROOF
      if let proofTarget {
        return try PublishedRelayWebSocketQuery.queryForProof(proofTarget.url, subscription: send.frame,
          addresses: proofTarget.addresses, anchorDER: proofTarget.anchorDER,
          publication: .init(mayContinue: { self.mayContinue() }, send: { emit in
            proofTarget.beforeSend()
            try self.performSend(emit)
          }), classifyText: { try self.acknowledgement.classify($0) }, completion: { self.complete($0) })
      }
#endif
      return try PublishedRelayWebSocketQuery.query(send.relay, subscription: send.frame,
        publication: .init(mayContinue: { self.mayContinue() }, send: { emit in
          try self.performSend(emit)
        }), classifyText: { try self.acknowledgement.classify($0) }, completion: { self.complete($0) })
    }
    private func performSend(_ emit: @Sendable () -> Void) throws {
      try lock.withLock {
        guard !cancelled, !ended else { throw NativeOutboxPlan.Failure.revoked }
        try ApprovalTransport.registry.sendOutbox(token, operation: send, send: emit)
      }
    }
    func cancel() {
      let operation = lock.withLock { cancelled = true; return self.operation }
      operation?.cancel()
      complete(.failure(NativeOutboxPlan.Failure.revoked))
    }
    func complete(_ result: Result<[String], Error>) {
#if HYPERGOLIC_NETWORK_PROOF
      if case .failure(let error) = result { proofTarget?.onFailure?(String(describing: error)) }
#endif
      let captured: (CheckedContinuation<String, Never>, DispatchSourceTimer?)? = lock.withLock {
        guard !ended, let continuation else { return nil }
        ended = true; let timer = self.timer; self.timer = nil; self.continuation = nil; self.operation = nil
        return (continuation, timer)
      }
      guard let captured else { return }
      captured.1?.cancel()
      var status = send.wasAttempted ? "unknown" : "cancelled-before-send"
      var reason = send.wasAttempted ? "relay acknowledgement unavailable" : "publication stopped before send"
      if let ack = acknowledgement.result { status = ack.accepted ? "accepted" : "rejected"; reason = ack.reason }
      let receipt = try? OutboxPublicationOwner.receipt(send, status: status, reason: reason)
      // Encoding has only captured, bounded native strings; a failure remains a finite failure envelope.
      captured.0.resume(returning: receipt ?? "{}")
    }
  }
}
