import Foundation

final class UploadRegistryClock: @unchecked Sendable { var value: Int64 = 0 }
@main struct UploadRegistryProof {
  static func main() throws {
    let png = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("valid.png"))
    let id = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", server = "https://files.example.com"
    var checks = 0
    func check(_ value: Bool) {checks += 1; precondition(value, "Registry check \(checks)")}
    let clock = UploadRegistryClock(), registry = UploadLeaseRegistry(clock: {clock.value})
    check(!registry.register("denied", identity: id, registration: "native denied origin", granted: false))
    check(registry.register("a", identity: id, registration: "native origin a", granted: true))
    check(registry.register("b", identity: id, registration: "native origin b", granted: true))
    check(registry.register("c", identity: id, registration: "native origin c", granted: true))
    check(!registry.register("a", identity: id, registration: "replacement", granted: true))
    check(registry.begin("a", callerId: "one", requestText: "request", length: png.count, destination: server) == nil)
    registry.foreground(true); registry.focus("a", active: true)
    let token = registry.begin("a", callerId: "one", requestText: "immutable native request", length: png.count, destination: server); check(token != nil)
    let publicId = registry.publicId("a", token: token!); check(publicId != nil && publicId != token); check(registry.publicId("b", token: token!) == nil)
    check(registry.append("b", token: token!, offset: 0, chunk: png) == nil); check(!registry.seal("b", token: token!)); check(!registry.cancelOwned("b", token: token!))
    check(registry.take(publicId!) == nil); check(registry.take(token!) == nil); check(registry.append("a", token: token!, offset: 0, chunk: png) == png.count)
    check(registry.append("a", token: token!, offset: 0, chunk: png) == nil); check(registry.seal("a", token: token!))
    let taken = registry.take(token!); check(taken?.registration == "native origin a" && taken?.request == "immutable native request")
    // Native upload signing must start from the approved file grant, not a sealed review alone.
    check(registry.signingCapture(token!) == nil)
    check(!registry.claimNativeSigning(token!, expected: taken!.review))
    check(!registry.nativeSigningLifetime(token!))
    check(registry.take(token!) == nil); check(registry.preview(token!, offset: 0) == png); check(registry.preview(token!, offset: 1) == nil)
    check(registry.begin("a", callerId: "same realm", requestText: "request", length: png.count, destination: server) == nil)
    check(registry.begin("b", callerId: "two", requestText: "request", length: png.count, destination: server) != nil)
    let third = registry.begin("c", callerId: "third", requestText: "request", length: png.count, destination: server); check(third != nil); check(registry.cancelOwned("c", token: third!)); check(registry.drainInvalid().count == 1)
    check(registry.approve(token!)); check(!registry.approve(token!)); check(registry.preview(token!, offset: 0) == nil)
    check(registry.signingCapture(token!)?.review === taken!.review)
    check(registry.claimNativeSigning(token!, expected: taken!.review))
    check(!registry.claimNativeSigning(token!, expected: taken!.review))
    check(registry.signingCapture(token!) == nil)
    check(registry.pauseNativeSigning(token!, paused: true))
    check(registry.nativeSigningLifetime(token!)); check(!registry.isLive(token!)); check(!registry.isApproved(token!))
    check(!registry.claimSigning(token!)); check(!registry.claimNativeSigning(token!, expected: taken!.review))
    check(registry.pauseNativeSigning(token!, paused: false)); check(registry.isApproved(token!))
    check(registry.claimSigning(token!)); check(!registry.claimSigning(token!))
    registry.focus("b", active: true); registry.focus("a", active: false); check(registry.isApproved(token!))
    check(registry.transfer(token!, credential: CommandLine.arguments[3], now: 1001) == nil)
    let transfer = registry.transfer(token!, credential: CommandLine.arguments[2], now: 1001); check(transfer != nil); check(transfer?.registration == "native origin a" && transfer?.uploadId == publicId)
    check(transfer!.authority.claimTransfer(transfer!.grant)); check(!transfer!.authority.claimTransfer(transfer!.grant))
    check(transfer!.authority.dispatch(transfer!.grant) == png); check(transfer!.authority.dispatch(transfer!.grant) == nil)
    registry.foreground(false); check(!registry.isLive(token!)); check(registry.wasDispatched(token!))
    let invalid = registry.drainInvalid(); check(invalid.count == 2); check(invalid.first(where: {$0.token == token!})?.dispatched == true)
    check(registry.wasDispatched(token!)); check(!registry.finish(token!))
    registry.foreground(true); check(registry.begin("a", callerId: "one", requestText: "replay", length: png.count, destination: server) == nil)
    let fresh = registry.begin("a", callerId: "fresh", requestText: "request", length: png.count, destination: server); check(fresh != nil)
    registry.revoke("a"); check(registry.append("a", token: fresh!, offset: 0, chunk: png) == nil); check(registry.take(fresh!) == nil)
    check(registry.drainInvalid().count == 1); check(registry.register("a", identity: id, registration: "new native origin", granted: true))
    check(!registry.cancelOwned("a", token: fresh!))
    let expiry = registry.begin("a", callerId: "expired", requestText: "request", length: png.count, destination: server); check(expiry != nil)
    clock.value = NativeUploadAuthority.reviewMS; check(!registry.seal("a", token: expiry!)); check(registry.drainInvalid().count == 1)
    check(registry.wasDispatched("missing"))
    // A previously admitted native source must lose its lifetime on each existing revocation path.
    for ending in ["cancel", "revoke", "expiry"] {
      let time = UploadRegistryClock(), source = UploadLeaseRegistry(clock: { time.value })
      check(source.register("signing", identity: id, registration: "native upload source", granted: true))
      source.foreground(true); source.focus("signing", active: true)
      let row = source.begin("signing", callerId: ending, requestText: "request", length: png.count, destination: server)!
      check(source.append("signing", token: row, offset: 0, chunk: png) == png.count)
      check(source.seal("signing", token: row)); let capture = source.take(row)!
      check(source.approve(row)); check(source.claimSigning(row))
      check(source.claimNativeSigning(row, expected: capture.review)); check(source.nativeSigningLifetime(row))
      if ending == "cancel" { source.cancel(row) }
      else if ending == "revoke" { source.revoke("signing") }
      else { time.value = NativeUploadAuthority.transferMS }
      check(!source.nativeSigningLifetime(row)); check(source.signingCapture(row) == nil)
      check(!source.claimNativeSigning(row, expected: capture.review)); check(!source.wasDispatched(row))
    }
    print("{\"language\":\"Swift\",\"uploadRegistryChecks\":\(checks),\"failed\":0}")
  }
}
