import Foundation
@main struct Proof {
 static func main() throws {
  let input=try JSONSerialization.jsonObject(with: Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any];var count=0
  func raw(_ value:Any) throws -> String {String(decoding:try JSONSerialization.data(withJSONObject:value),as:UTF8.self)}
  for row in input["configs"] as! [[String:Any]] {let parsed=try? CapabilityConfiguration(raw(row["value"]!),generation:"generation");precondition((parsed != nil)==(row["ok"] as! Bool),row["name"] as! String);count+=1}
  let config=try CapabilityConfiguration(raw(input["base"]!),generation:"generation")
  precondition(!config.allowsRelayOperation("relay.publish") && !config.allowsRelayOperation("relay.subscribe") && config.domains.isEmpty);count+=1
  let context=config.legacyReadOnly!;precondition(context.matches(event:context.eventId,hash:context.htmlHash));precondition(!context.matches(event:String(repeating:"0",count:64),hash:context.htmlHash));precondition(!context.matches(event:context.eventId,hash:String(repeating:"0",count:64)));count+=3
  for row in input["requests"] as! [[String:Any]] {let value=row["value"] as! [String:Any];precondition(context.allowsSubscribe(value)==(row["subscribe"] as! Bool),row["name"] as! String);precondition(context.allowsClose(value)==(row["close"] as! Bool),row["name"] as! String);count+=2}
  for row in input["images"] as! [[String:Any]] {precondition(context.allowsImage(row["value"] as! [String:Any])==(row["ok"] as! Bool),row["name"] as! String);count+=1}
  let effects=input["effects"] as! [[String:Any]];precondition(CapabilityTransport.leases.register("generation"))
  for (index,row) in effects.enumerated() {
    var registration=row["registration"] as! [String:Any];registration["generation"]="generation"
    let captured=try raw(["registration":registration,"request":try raw(row["request"]!)])
    let url=row["url"] as! String;let expected=row["ok"] as! Bool
    precondition(LegacyReadOnlyContext.permitsImage(captured,url:url)==expected,row["name"] as! String);count+=1
    let lease=CapabilityTransport.leases.admit("generation",sequence:UInt64(index+1),snapshot:captured)!
    precondition((try? ResourceHTTPSBridgeOwner.admission(lease,url:url))==nil);precondition(CapabilityTransport.leases.take(lease)==captured)
    precondition(((try? ResourceHTTPSBridgeOwner.admission(lease,url:url)) != nil)==expected,row["name"] as! String);count+=3
    _=CapabilityTransport.leases.finish(lease);precondition((try? ResourceHTTPSBridgeOwner.admission(lease,url:url))==nil);count+=1
  }
  let image=input["image"] as! [String:Any];let imageSnapshot=try config.request(raw(image));let imageURL=image["url"] as! String
  let imageToken=CapabilityTransport.leases.admit("generation",sequence:UInt64(effects.count+1),snapshot:imageSnapshot)!;precondition(CapabilityTransport.leases.take(imageToken) != nil)
  _=CapabilityTransport.leases.setForeground(false);precondition((try? ResourceHTTPSBridgeOwner.admission(imageToken,url:imageURL))==nil);count+=1
  _=CapabilityTransport.leases.setForeground(true)
  let generationToken=CapabilityTransport.leases.admit("generation",sequence:UInt64(effects.count+2),snapshot:imageSnapshot)!;precondition(CapabilityTransport.leases.take(generationToken) != nil)
  CapabilityTransport.leases.revoke("generation");precondition((try? ResourceHTTPSBridgeOwner.admission(generationToken,url:imageURL))==nil);count+=1
  precondition(CapabilityTransport.leases.register("generic"))
  for (index,grants) in [["resource"],[]].enumerated() {
    let captured=try raw(["registration":["generation":"generic","domains":grants],"request":try raw(["type":"resource.bytes","id":"ordinary","url":"https://cdn.primal.net/a"])])
    let lease=CapabilityTransport.leases.admit("generic",sequence:UInt64(index+1),snapshot:captured)!;precondition(CapabilityTransport.leases.take(lease) != nil)
    precondition(((try? ResourceHTTPSBridgeOwner.admission(lease,url:"https://cdn.primal.net/a")) != nil) == !grants.isEmpty);_=CapabilityTransport.leases.finish(lease);count+=1
  }
  precondition(CapabilityTransport.leases.register("expired"))
  let expired=CapabilityTransport.leases.admit("expired",sequence:1,snapshot:imageSnapshot)!;precondition(CapabilityTransport.leases.take(expired) != nil)
  CapabilityTransport.clock.instant=CapabilityTransport.clock.instant.advanced(by:.seconds(25));precondition((try? ResourceHTTPSBridgeOwner.admission(expired,url:imageURL))==nil);count+=1
  let snapshot=try config.request(raw(input["request"]!))
  for row in input["wires"] as! [[String:Any]] {precondition(LegacyReadOnlyContext.permitsWire(snapshot,url:row["url"] as! String,wire:row["wire"] as! String,subId:"native-sub")==(row["ok"] as! Bool),row["name"] as! String);count+=1}
  precondition(!LegacyReadOnlyContext.permitsWire(nil,url:"wss://relay.damus.io",wire:"[]",subId:"native-sub"));count+=1
  let clock=ClockBox();let registry=RelaySubscriptionRegistry(now:{clock.instant},generationActive:{_ in clock.active});registry.setForeground(true)
  let token=registry.admit("generation",snapshot:snapshot)!;precondition(registry.take(token)==snapshot);precondition(registry.accept(token));precondition(registry.capturedSnapshot(token)==snapshot);count+=3
  registry.setForeground(false);precondition(!registry.mayDeliver(token));precondition(registry.admit("generation",snapshot:snapshot)==nil);count+=2
  registry.setForeground(true);let second=registry.admit("generation",snapshot:snapshot)!;let third=registry.admit("generation",snapshot:snapshot)!;precondition(registry.admit("generation",snapshot:snapshot)==nil);count+=1
  clock.instant=clock.instant.advanced(by:.seconds(25));precondition(registry.take(second)==nil && registry.take(third)==nil);count+=1
  clock.active=false;precondition(!registry.isActive(token) && registry.capturedSnapshot(token)==nil);count+=1
  var history=LegacyReadOnlyContext.HistoryBudget();for _ in 0..<32 {precondition(history.receive("[\"EVENT\",\"sub\",{}]"))};precondition(!history.receive("[\"EVENT\",\"sub\",{}]"));count+=33
  var live=LegacyReadOnlyContext.HistoryBudget();precondition(live.receive("[\"EOSE\",\"sub\"]"));for _ in 0..<40 {precondition(live.receive("[\"EVENT\",\"sub\",{}]"))};count+=41
  print("Swift legacy read-only: \(count) checks passed")
 }
}
final class ClockBox: @unchecked Sendable {var instant=ContinuousClock.now;var active=true}
