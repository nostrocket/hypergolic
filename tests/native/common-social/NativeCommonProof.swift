import Foundation

@MainActor @main struct NativeCommonProof{
  static var checks=0
  static func check(_ value:Bool){precondition(value);checks+=1}
  static func denied(_ work:()throws->Void){do{try work();preconditionFailure("Expected denial")}catch{checks+=1}}
  static func main()throws{
    let rows=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [[String:Any]]
    for row in rows{
      let snapshot=row["snapshot"] as! String,raw=row["plan"] as! String,plan=try NativeCommonPlan.capture(snapshot:snapshot,raw:raw)
      check((plan.publication==nil)==(row["noop"] as! Bool))
      var changed=try NativeOutboxPlan.object(raw),request=changed["request"] as! [String:Any];request["id"]="foreign-request";changed["request"]=request
      denied{_ = try NativeCommonPlan.capture(snapshot:snapshot,raw:NativeCommonPlan.canonical(changed))}
      var old=try NativeOutboxPlan.object(snapshot),registration=old["registration"] as! [String:Any];registration.removeValue(forKey:"commonProfile");old["registration"]=registration
      denied{_ = try NativeCommonPlan.capture(snapshot:NativeCommonPlan.canonical(old),raw:raw)}
      registration["commonProfile"]="social-v1";registration["domains"]=["common","outbox"];old["registration"]=registration
      denied{_ = try NativeCommonPlan.capture(snapshot:NativeCommonPlan.canonical(old),raw:raw)}
      if let template=plan.template{
        let source=try NativeOutboxPlan.object(raw),publication=source["publication"] as! [String:Any],review=publication["event"] as! [String:Any]
        var extra=source,extraPublication=publication;extraPublication["ancillary"]=[String:Any]();extra["publication"]=extraPublication
        denied{_ = try NativeCommonPlan.capture(snapshot:snapshot,raw:NativeCommonPlan.canonical(extra))}
        extraPublication=publication;extraPublication["requiredInboxes"]=["wss://relay.damus.io/"];extra["publication"]=extraPublication
        denied{_ = try NativeCommonPlan.capture(snapshot:snapshot,raw:NativeCommonPlan.canonical(extra))}
        let captured=try NativeOutboxPlan.signingSnapshot(snapshot:snapshot,raw:NativeCommonPlan.canonical(review),derived:template)
        check(captured.destinations==["wss://relay.damus.io/"])
        var tamper=review,event=tamper["event"] as! [String:Any];event["content"]="altered";tamper["event"]=event
        denied{_ = try NativeOutboxPlan.signingSnapshot(snapshot:snapshot,raw:NativeCommonPlan.canonical(tamper),derived:template)}
        changed=source;changed["publication"]=NSNull();denied{_ = try NativeCommonPlan.capture(snapshot:snapshot,raw:NativeCommonPlan.canonical(changed))}
      }
    }
    print("NativeCommonProof: \(checks) checks passed; supplied bytes only, no signer/socket/device effects")
  }
}
