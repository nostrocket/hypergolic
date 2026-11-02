import Foundation
import Network

private final class ResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Result<[String], Error>?

  func set(_ value: Result<[String], Error>) {
    lock.lock(); defer { lock.unlock() }
    stored = value
  }

  func get() -> Result<[String], Error>? {
    lock.lock(); defer { lock.unlock() }
    return stored
  }
}

@main private struct PublishedRelayWssTlsProof {
  static func main() throws {
    let args = CommandLine.arguments
    guard args.count == 4, let port = UInt16(args[1]),
          let anchor = try? Data(contentsOf: URL(fileURLWithPath: args[2])) else {
      throw NSError(domain: "proof arguments", code: 1)
    }
    let mode = args[3]
    let loopback = PublishedPinnedHTTPS.Address(host: .ipv4(IPv4Address("127.0.0.1")!),
                                                  bytes: Data([127, 0, 0, 1]))
    let addresses: [PublishedPinnedHTTPS.Address]
    if mode == "failover" {
      addresses = [PublishedPinnedHTTPS.Address(host: .ipv6(IPv6Address("::1")!),
                                                 bytes: Data(repeating: 0, count: 15) + Data([1])), loopback]
    } else { addresses = [loopback] }
    let result = ResultBox()
    let done = DispatchSemaphore(value: 0)
    let operation = try PublishedRelayWebSocketQuery.queryForProof(
      "wss://relay.example.org:\(port)/fixture", subscription: "[\"REQ\",\"proof\",{\"kinds\":[35129]}]",
      addresses: addresses, anchorDER: mode == "untrusted" ? nil : anchor,
      classifyText: { value in
        if mode == "auth-announcement" { return PublishedRelayEnvelope.classify(value, subscriptionId: "proof") }
        switch value {
        case "EVENT": return .event
        case "EOSE": return .eose
        default: return .invalid
        }
      }, completion: { outcome in
        result.set(outcome)
        done.signal()
      }
    )
    if mode == "cancel" {
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { operation.cancel() }
    }
    guard done.wait(timeout: .now() + 9) == .success, let outcome = result.get() else {
      throw NSError(domain: "proof timed out", code: 1)
    }
    switch (mode, outcome) {
    case ("valid", .success(let envelopes)), ("failover", .success(let envelopes)):
      guard envelopes == ["EVENT", "EOSE"] else { throw NSError(domain: "wrong relay envelopes", code: 1) }
    case ("auth-announcement", .success(let envelopes)):
      guard envelopes == ["[\"AUTH\",\"first\"]", "[\"AUTH\",\"rotated\"]", "[\"EOSE\",\"proof\"]"] else {
        throw NSError(domain: "wrong AUTH relay envelopes", code: 1)
      }
    case ("untrusted", .failure), ("wrong-host", .failure), ("redirect", .failure),
         ("bad-accept", .failure), ("oversize", .failure):
      break
    case ("cancel", .failure(let error)):
      guard case PublishedRelayWebSocketQuery.Failure.cancelled = error else {
        throw NSError(domain: "wrong cancellation result", code: 1)
      }
    default:
      throw NSError(domain: "unexpected WSS outcome for \(mode): \(outcome)", code: 1)
    }
    print("{\"mode\":\"\(mode)\",\"checks\":1,\"failed\":0}")
  }
}
