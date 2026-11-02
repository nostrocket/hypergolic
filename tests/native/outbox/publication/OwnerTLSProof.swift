import Foundation
import Network

@main struct OwnerTLSProof {
  static func main() async throws {
    let args = CommandLine.arguments, mode = args[3], port = UInt16(args[1])!
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[4]))) as! [String: Any]
    let generation = "owner-" + mode, snapshot = fixture["snapshot"] as! String
    precondition(CapabilityTransport.leases.register(generation))
    let registry = ApprovalTransport.registry
    precondition(registry.register(generation)); registry.setForeground(true); registry.setFocused(generation, active: true)
    defer { registry.revoke(generation); CapabilityTransport.leases.revoke(generation) }
    let token = registry.admit(generation, snapshot: snapshot, wireId: "native-outbox-publication", reply: { _ in })!
    precondition(registry.take(token) == snapshot)
    let planWire = try proofWire(fixture["plan"]!)
    precondition(registry.prepareOutbox(token, raw: planWire))
    precondition(registry.approve(token)); precondition(registry.isApproved(token))
    let address = PublishedPinnedHTTPS.Address(host: .ipv4(IPv4Address("127.0.0.1")!), bytes: Data([127, 0, 0, 1]))
    let handle = ProofTaskHandle(), gate = ProofStartGate()
    let owner = OutboxPublicationOwner(proofTarget: .init(url: "wss://relay.example.org:\(port)/fixture", addresses: [address],
      anchorDER: try Data(contentsOf: URL(fileURLWithPath: args[2])), beforeSend: {
        if mode == "revoke-before-send" { registry.setForeground(false) }
        if mode == "task-cancel-before-send" { handle.cancel() }
      }))
    let primary = fixture["primary"] as! [String: Any], primaryWire = try proofWire(primary)
    let started = DispatchTime.now().uptimeNanoseconds
    let task = Task<String, Error> {
      await gate.wait()
      return try await owner.publish(token: token, group: "primary", event: primaryWire, relay: "wss://relay.damus.io/")
    }
    handle.install(task)
    let afterSend = mode == "revoke-after-send" || mode == "task-cancel-after-send"
    let marker = afterSend ? args[5] : ""
    let trigger: Task<Bool, Error>? = afterSend ? Task {
      let end = ContinuousClock.now.advanced(by: .seconds(5))
      while ContinuousClock.now < end {
        if FileManager.default.fileExists(atPath: marker) {
          if mode == "revoke-after-send" { registry.setForeground(false) } else { handle.cancel() }
          return true
        }
        try await Task.sleep(for: .milliseconds(5))
      }
      return false
    } : nil
    defer { trigger?.cancel() }
    await gate.release()
    let raw = try await task.value
    let observedTrigger = try await trigger?.value ?? false
    let elapsed = (DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
    let expected = mode == "accepted" || mode == "accepted-close" ? "accepted" : mode == "rejected" ? "rejected" :
      mode == "revoke-before-send" || mode == "task-cancel-before-send" ? "cancelled-before-send" : "unknown"
    let receipt = try proofReceipt(raw, expected: expected)
    precondition(receipt["eventId"] == primary["id"] as? String && receipt["relay"] == "wss://relay.damus.io/")
    precondition(!afterSend || observedTrigger && elapsed < 3_000)
    precondition(handle.cancellations == (mode.hasPrefix("task-cancel-") ? 1 : 0))
    if expected == "accepted" { precondition(receipt["reason"] == "stored") }
    if expected == "rejected" { precondition(receipt["reason"] == "blocked") }
    proofOwnerIdle(owner)
    print(try proofWire(["mode": mode, "status": "passed", "receipt": receipt, "elapsedMs": elapsed,
      "taskCancellations": handle.cancellations, "afterSendTrigger": observedTrigger, "ownerIdle": true,
      "scope": "Actual Swift owner/WSS controlled host proof; no device, signer, guest/Expo or public DNS proof"]))
  }
}
