import Foundation
import UIKit

final class FixtureReleaseTransport: @unchecked Sendable {
  static let shared = FixtureReleaseTransport()
  let owner = FixtureReleaseAuthority(clock: {Int64(ProcessInfo.processInfo.systemUptime*1000)})
  private let https = PublishedHTTPSBridgeOwner()
  private var observers: [NSObjectProtocol] = []
  private init() {
    let center=NotificationCenter.default
    for name in [UIApplication.willResignActiveNotification,UIApplication.didEnterBackgroundNotification] {
      observers.append(center.addObserver(forName:name,object:nil,queue:nil){[weak self] _ in self?.owner.foreground(false)})
    }
    observers.append(center.addObserver(forName:UIApplication.didBecomeActiveNotification,object:nil,queue:nil){[weak self] _ in self?.owner.foreground(true)})
    Task {@MainActor in self.owner.foreground(UIApplication.shared.applicationState == .active)}
  }
  deinit {for observer in observers {NotificationCenter.default.removeObserver(observer)};owner.cancel()}
  func synchronize(_ user: String, epoch: UInt64, available: Bool) throws {
    guard owner.synchronize(user,epoch:epoch,available:available) else {throw UploadWire.Invalid.value}
  }
  func cancel() {owner.cancel()}
  func prepare(_ fixture: String, server: String) throws -> String {
    let module=Bundle(for:NappletHostModule.self)
    guard let url=module.url(forResource:"HypergolicNappletHostAssets",withExtension:"bundle") ?? Bundle.main.url(forResource:"HypergolicNappletHostAssets",withExtension:"bundle"),
      let bundle=Bundle(url:url), let catalogURL=bundle.url(forResource:"fixture-release",withExtension:"json") else {throw UploadWire.Invalid.value}
    let catalogBytes=try Data(contentsOf:catalogURL,options:.mappedIfSafe)
    guard catalogBytes.count <= 1024*1024,
      let catalog=try JSONSerialization.jsonObject(with:catalogBytes) as? [String:Any],
      let artifacts=catalog["artifacts"] as? [String:[String:Any]], let artifact=artifacts[fixture], let html=artifact["html"] as? String,
      let hash=artifact["sha256"] as? String, let aggregate=artifact["aggregate"] as? String,
      FixtureReleaseAuthority.hash(Data((hash + " /index.html\n").utf8)) == aggregate,
      let tags=artifact["tags"] as? [[String]], tags.first == ["d",fixture],
      let tagText=String(data:try JSONSerialization.data(withJSONObject:tags),encoding:.utf8),
      let row=owner.prepare(fixture,bytes:Data(html.utf8),expectedHash:hash,server:server,tags:tagText) else {throw UploadWire.Invalid.value}
    return try UploadWire.json(["token":row.token,"fixture":fixture,"identity":row.identity,"server":row.server,"sha256":row.review.sha256,
      "size":row.review.size,"html":html,"tags":tags])
  }
  func approveUpload(_ token: String) -> Bool {owner.approveUpload(token)}
  func uploadApproved(_ token: String) -> Bool {owner.uploadApproved(token)}
  func manifestApproved(_ token: String) -> Bool {owner.manifestApproved(token)}
  func prepareManifest(_ token: String, relays: [String]) throws -> String {
    guard let row=owner.current(token), (1...8).contains(relays.count), Set(relays).count == relays.count,
      relays.allSatisfy({$0.hasPrefix("wss://") && $0.utf8.count <= 2048}),
      let original=try JSONSerialization.jsonObject(with:Data(row.manifestTags.utf8)) as? [[String]] else {throw UploadWire.Invalid.value}
    let event: [String:Any] = ["kind":35129,"created_at":Int64(Date().timeIntervalSince1970),"content":"","tags":original + [["server",row.server]]]
    let snapshot=try UploadWire.json(["identity":row.identity,"relays":relays,"event":event])
    guard owner.prepareManifest(token,snapshot:snapshot) else {throw UploadWire.Invalid.value};return snapshot
  }
  func approveManifest(_ token: String) -> String? {owner.approveManifest(token)}
  func put(_ token: String, credential: String) async -> String {
    guard let row=owner.current(token), let grant=row.grant, owner.uploadApproved(token),
      let permit=NativeBlossomPermit.capture(row.review,token:credential,now:Int64(Date().timeIntervalSince1970)),
      let registration=try? UploadWire.json(["user":row.identity,"publisher":row.identity,"appId":row.fixture]) else {return "{\"ok\":false,\"error\":\"policy denied\"}"}
    let transfer=UploadLeaseRegistry.Transfer(authority:owner.uploads,grant:grant,permit:permit,registration:registration,uploadId:UUID().uuidString.lowercased())
    let raw=await UploadTransport.putTrustedFixture(transfer)
    do {
      var result=try UploadWire.object(raw)
      guard result["ok"] as? Bool == true else {return raw}
      let encoded=try await https.fetch(operationId:UUID().uuidString.lowercased(),url:row.server + "/" + row.review.sha256)
      guard let bytes=Data(base64Encoded:encoded), owner.verifyRetrieved(token,bytes:bytes) else {throw UploadWire.Invalid.value}
      result["retrievedSha256"]=FixtureReleaseAuthority.hash(bytes);result["retrievedSize"]=bytes.count
      return try UploadWire.json(result)
    } catch {return "{\"ok\":false,\"error\":\"upload accepted; payload retrieval unverified\"}"}
  }
}
