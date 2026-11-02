import Foundation
import Network

private final class ResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Result<PublishedHTTPResponse, Error>?

  func set(_ value: Result<PublishedHTTPResponse, Error>) {
    lock.lock(); defer { lock.unlock() }
    stored = value
  }

  func get() -> Result<PublishedHTTPResponse, Error>? {
    lock.lock(); defer { lock.unlock() }
    return stored
  }
}

@main private struct PublishedHTTPSTlsProof {
  static func main() throws {
    let args = CommandLine.arguments
    guard args.count == 4, let port = UInt16(args[1]),
          let anchor = try? Data(contentsOf: URL(fileURLWithPath: args[2])) else {
      throw NSError(domain: "proof arguments", code: 1)
    }
    let mode = args[3]
    let loopback = PublishedPinnedHTTPS.Address(host: .ipv4(IPv4Address("127.0.0.1")!),
                                                  bytes: Data([127, 0, 0, 1]))
    if mode == "mixed-dns" {
      let publicAddress = PublishedPinnedHTTPS.Address(host: .ipv4(IPv4Address("8.8.8.8")!),
                                                        bytes: Data([8, 8, 8, 8]))
      for answers in [[publicAddress, loopback], [loopback, publicAddress], []] {
        do {
          _ = try PublishedPinnedHTTPS.vetResolvedAddresses(answers)
          throw NSError(domain: "mixed/empty DNS was accepted", code: 1)
        } catch PublishedPinnedHTTPS.Failure.privateAddress { }
      }
      guard try PublishedPinnedHTTPS.vetResolvedAddresses([publicAddress]).count == 1 else {
        throw NSError(domain: "public DNS was rejected", code: 1)
      }
      print("{\"mode\":\"mixed-dns\",\"checks\":4,\"failed\":0}")
      return
    }
    let addresses: [PublishedPinnedHTTPS.Address]
    if mode == "failover" {
      addresses = [PublishedPinnedHTTPS.Address(host: .ipv6(IPv6Address("::1")!),
                                                 bytes: Data(repeating: 0, count: 15) + Data([1])), loopback]
    } else { addresses = [loopback] }
    let result = ResultBox()
    let done = DispatchSemaphore(value: 0)
    let operation = try PublishedPinnedHTTPS.fetchForProof(
      "https://blossom.example.net:\(port)/fixture", maximumBodyBytes: 64,
      addresses: addresses, anchorDER: mode == "untrusted" ? nil : anchor
    ) { outcome in
      result.set(outcome)
      done.signal()
    }
    if mode == "cancel" {
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { operation.cancel() }
    }
    guard done.wait(timeout: .now() + 8) == .success, let outcome = result.get() else {
      throw NSError(domain: "proof timed out", code: 1)
    }
    switch (mode, outcome) {
    case ("valid", .success(let response)), ("failover", .success(let response)):
      guard response.status == 200, response.body == Data("proof".utf8) else {
        throw NSError(domain: "wrong HTTPS response", code: 1)
      }
    case ("untrusted", .failure), ("wrong-host", .failure), ("redirect", .failure):
      break
    case ("cancel", .failure(let error)):
      guard case PublishedPinnedHTTPS.Failure.cancelled = error else {
        throw NSError(domain: "wrong cancellation result", code: 1)
      }
    default:
      throw NSError(domain: "unexpected HTTPS outcome for \(mode): \(outcome)", code: 1)
    }
    print("{\"mode\":\"\(mode)\",\"checks\":1,\"failed\":0}")
  }
}
