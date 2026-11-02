import Foundation
import Network

enum CapabilityTransport { static let leases = CapabilityLeaseRegistry() }
private final class Box: @unchecked Sendable {
 let lock=NSLock();var result:Result<[String],Error>?
 func store(_ value:Result<[String],Error>){lock.withLock{result=value}}
}
@main struct TLSProof {
 static func main() throws {
  let args=CommandLine.arguments,mode=args[3],port=UInt16(args[1])!
  let fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:args[4]))) as! [String:Any]
  func wire(_ value:Any) throws -> String{String(decoding:try JSONSerialization.data(withJSONObject:value),as:UTF8.self)}
  let snapshot=fixture["snapshot"] as! String,plan=try wire(fixture["plan"]!),primary=try wire(fixture["primary"]!)
  let leases=CapabilityLeaseRegistry();precondition(leases.register("owner-a"))
  let registry=ApprovalTransportRegistry(leases:leases,schedule:{_,_ in})
  precondition(registry.register("owner-a"));registry.setForeground(true);registry.setFocused("owner-a",active:true)
  let token=registry.admit("owner-a",snapshot:snapshot,wireId:"tls-proof",reply:{_ in})!
  precondition(registry.take(token)==snapshot);precondition(registry.prepareOutbox(token,raw:plan));precondition(registry.approve(token))
  let send=try registry.reserveOutbox(token,group:"primary",wire:primary,relay:"wss://relay.damus.io/")
  let ack=OutboxAcknowledgement(send.eventId),box=Box(),done=DispatchSemaphore(value:0)
  let address=PublishedPinnedHTTPS.Address(host:.ipv4(IPv4Address("127.0.0.1")!),bytes:Data([127,0,0,1]))
  let operation=try PublishedRelayWebSocketQuery.queryForProof("wss://relay.example.org:\(port)/fixture",subscription:send.frame,
   addresses:[address],anchorDER:Data(contentsOf:URL(fileURLWithPath:args[2])),
   publication:.init(mayContinue:{true},send:{emit in
    if mode=="revoke-before-send"{registry.setForeground(false)}
    try registry.sendOutbox(token,operation:send,send:emit)
   }),classifyText:{try ack.classify($0)},completion:{box.store($0);done.signal()})
  guard done.wait(timeout: .now()+9) == .success else{operation.cancel();throw NSError(domain:"TLS proof timeout",code:1)}
  let accepted=ack.result?.accepted
  precondition(send.wasAttempted == (mode != "revoke-before-send"))
  if mode=="accepted"||mode=="accepted-close"{precondition(accepted==true)}
  else if mode=="rejected"{precondition(accepted==false)}else{precondition(accepted==nil)}
  print(try wire(["mode":mode,"attempted":send.wasAttempted,"ack":accepted.map{$0 as Any} ?? NSNull(),"eventId":send.eventId,"status":"passed"]))
 }
}
