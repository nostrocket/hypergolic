import Foundation
import Network
private final class Memory: UploadRecoveryLedger.Store, @unchecked Sendable {
  var value: Data?
  func read() -> Data? {value}
  func write(_ bytes: Data) {value = bytes}
}
private final class Box: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Result<PublishedHTTPResponse, Error>?
  func set(_ value: Result<PublishedHTTPResponse, Error>) {lock.withLock {self.value = value}}
  func get() -> Result<PublishedHTTPResponse, Error>? {lock.withLock {value}}
}
@main struct Proof {
  static func main() throws {
    let args = CommandLine.arguments, mode = args[3], identity = String(repeating: "a", count: 64)
    let record = try UploadRecoveryLedger.Entry(uploadId: "00000000-0000-0000-0000-000000000001", identity: identity, publisher: String(repeating: "b", count: 64), appId: "app", destination: "https://files.example.com:" + args[1],
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", mimeType: "text/plain", size: 3, state: .unknown)
    let ledger = try UploadRecoveryLedger(store: Memory()); let started = try ledger.start(record); precondition(started)
    let authority = UploadRecoveryReadAuthority(clock: {Int64(ProcessInfo.processInfo.systemUptime * 1000)})
    precondition(authority.register("realm", identity: identity)); authority.foreground(true); let lease = authority.capture(record)!
    if mode == "cancel-before" {authority.foreground(false); authority.foreground(true)}
    if (mode == "cancel-read" || mode == "redirect-cancel") {DispatchQueue.global().async { let deadline = ProcessInfo.processInfo.systemUptime + 5; while !FileManager.default.fileExists(atPath: args[4]) && ProcessInfo.processInfo.systemUptime < deadline {Thread.sleep(forTimeInterval: 0.005)}; authority.foreground(false); authority.foreground(true) }}
    var state = UploadRecoveryLedger.State.unknown
    do {
      if mode == "mixed-dns" {
        _ = try PublishedPinnedHTTPS.vetResolvedAddresses([.init(host: NWEndpoint.Host("127.0.0.1"), bytes: Data([127,0,0,1])), .init(host: NWEndpoint.Host("10.0.0.1"), bytes: Data([10,0,0,1]))])
        preconditionFailure("Mixed DNS accepted")
      }
      let semaphore = DispatchSemaphore(value: 0), box = Box()
      let anchor = mode == "untrusted" ? nil : try Data(contentsOf: URL(fileURLWithPath: args[2]))
      let operation = try PublishedPinnedHTTPS.fetchForProof(record.destination + "/" + record.sha256, maximumBodyBytes: NativeUploadAuthority.maxBytes, timeout: 5,
        addresses: [.init(host: NWEndpoint.Host("127.0.0.1"), bytes: Data([127,0,0,1]))], anchorDER: anchor,
        resolverForProof: {host in
          guard ["files.example.com", "other.example.com"].contains(host) else { throw PublishedPinnedHTTPS.Failure.resolution }
          if mode == "redirect-mixed-dns" {return try PublishedPinnedHTTPS.vetResolvedAddresses([.init(host: NWEndpoint.Host("8.8.8.8"), bytes: Data([8,8,8,8])), .init(host: NWEndpoint.Host("10.0.0.1"), bytes: Data([10,0,0,1]))])}
          return [.init(host: NWEndpoint.Host("127.0.0.1"), bytes: Data([127,0,0,1]))]
        }, recoveryProfile: true, active: {authority.live(lease)}, completion: {box.set($0); semaphore.signal()})
      precondition(semaphore.wait(timeout: .now() + 8) == .success, "Recovery timeout")
      withExtendedLifetime(operation) {}
      let response = try box.get()!.get(); state = try authority.finish(lease, status: response.status, body: response.body, ledger: ledger)
    } catch { /* Failed reads cannot settle the native record. */ }
    authority.cancel(lease)
    let blocked = try ledger.blocks(identity: identity, destination: record.destination, sha256: record.sha256)
    print("{\"language\":\"Swift\",\"state\":\"\(state)\",\"blocked\":\(blocked)}")
  }
}
