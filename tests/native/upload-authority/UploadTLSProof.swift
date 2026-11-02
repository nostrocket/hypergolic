import Foundation
import Network

private final class ResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var result: Result<PublishedHTTPResponse, UploadPinnedHTTPS.Failure>?
  func set(_ value: Result<PublishedHTTPResponse, UploadPinnedHTTPS.Failure>) { lock.withLock { result = value } }
  func get() -> Result<PublishedHTTPResponse, UploadPinnedHTTPS.Failure>? { lock.withLock { result } }
}
@main struct UploadTLSProof {
  static func main() throws {
    let args = CommandLine.arguments, port = Int(args[1])!, mode = args[4]
    let authority = NativeUploadAuthority(clock: { Int64(ProcessInfo.processInfo.systemUptime * 1000) })
    let session = authority.register("fixture", identity: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")!
    let other = authority.register("other", identity: String(repeating: "a", count: 64))!
    authority.setForeground(true); authority.focus(session)
    let request = authority.admit(session, length: 3, destination: "https://files.example.com:\(port)", mimeType: "application/octet-stream")!
    precondition(authority.append(request, offset: 0, chunk: Data([1,2,3])))
    let review = authority.seal(request)!, permit = NativeBlossomPermit.capture(review, token: args[3], now: 1001)!
    let grant = authority.approve(request, expected: review)!
    precondition(authority.claimSigning(grant) === review)
    if mode == "cancel-before" { authority.setForeground(false); authority.setForeground(true) }
    if mode == "mixed-dns" {
      do {
        _ = try PublishedPinnedHTTPS.vetResolvedAddresses([PublishedPinnedHTTPS.Address(host: .ipv4(IPv4Address("127.0.0.1")!), bytes: Data([127,0,0,1])),
          PublishedPinnedHTTPS.Address(host: .ipv4(IPv4Address("10.0.0.1")!), bytes: Data([10,0,0,1]))])
        preconditionFailure("Mixed DNS accepted")
      } catch { print("{\"language\":\"Swift\",\"error\":\"policy denied\",\"dispatched\":false}"); return }
    }
    let semaphore = DispatchSemaphore(value: 0), box = ResultBox()
    do {
      let anchor = mode == "untrusted" ? nil : try Data(contentsOf: URL(fileURLWithPath: args[2]))
      let operation = try UploadPinnedHTTPS.putForProof(authority, grant: grant, permit: permit,
        addresses: [PublishedPinnedHTTPS.Address(host: .ipv4(IPv4Address("127.0.0.1")!), bytes: Data([127,0,0,1]))],
        anchorDER: anchor, now: {1001}, progress: { _ in
          if mode == "switch" { authority.focus(other) }
          if mode == "cancel-after" { authority.setForeground(false); authority.setForeground(true) }
        }, completion: { value in box.set(value); semaphore.signal() })
      precondition(semaphore.wait(timeout: .now() + 8) == .success, "Upload deadline exceeded in proof")
      withExtendedLifetime(operation) {}
      switch box.get()! {
      case .success(let response): print("{\"language\":\"Swift\",\"status\":\(response.status),\"dispatched\":\(authority.wasDispatched(grant)),\"receiptBytes\":\(response.body.count)}")
      case .failure(let failure): print("{\"language\":\"Swift\",\"error\":\"\(failure.code)\",\"dispatched\":\(failure.dispatched)}")
      }
    } catch let failure as UploadPinnedHTTPS.Failure {
      print("{\"language\":\"Swift\",\"error\":\"\(failure.code)\",\"dispatched\":\(failure.dispatched)}")
    }
    authority.revokeAll()
  }
}
