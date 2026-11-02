import Foundation

// Host composition only; native capability, approval, plan and publication classes are production.
enum CapabilityTransport { static let leases = CapabilityLeaseRegistry() }

func proofWire(_ value: Any) throws -> String {
  String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
}

func proofReceipt(_ raw: String, expected: String) throws -> [String: String] {
  let value = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: String]
  precondition(Set(value.keys) == Set(["relay", "eventId", "status", "reason"]))
  precondition(value["status"] == expected, raw)
  return value
}

func proofOwnerIdle(_ owner: OutboxPublicationOwner) {
  let active = Mirror(reflecting: owner).children.first { $0.label == "active" }?.value as? Int
  precondition(active == 0, "Native owner capacity did not return idle")
}

actor ProofStartGate {
  private var open = false
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async {
    if open { return }
    await withCheckedContinuation { continuation = $0 }
  }
  func release() {
    open = true; continuation?.resume(); continuation = nil
  }
}

final class ProofTaskHandle: @unchecked Sendable {
  private let lock = NSLock()
  private var task: Task<String, Error>?
  private var count = 0
  func install(_ value: Task<String, Error>) { lock.withLock { precondition(task == nil); task = value } }
  func cancel() {
    let value = lock.withLock { count += 1; return task }
    precondition(value != nil); value?.cancel()
  }
  var cancellations: Int { lock.withLock { count } }
}
