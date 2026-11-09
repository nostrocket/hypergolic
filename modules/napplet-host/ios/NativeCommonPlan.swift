import Foundation

/// Immutable original intent plus derived review; app signature verification is mandatory before capture.
final class NativeCommonPlan:@unchecked Sendable{
  static let operations:Set<String>=["common.follow","common.unfollow","common.react","common.report"]
  let publication:NativeOutboxPlan?,template:[String:Any]?
  private init(_ publication:NativeOutboxPlan?,_ template:[String:Any]?){self.publication=publication;self.template=template}
  static func granted(_ registration:[String:Any])->Bool{
    guard let domains=registration["domains"] as? [String] else{return false}
    return registration["fixture"] as? String=="published" && registration["commonProfile"] as? String=="social-v1" && domains.contains("common") && domains.contains("identity") && (domains.contains("relay") || domains.contains("outbox"))
  }
  static func capture(snapshot:String,raw:String)throws->NativeCommonPlan{
    let envelope=try NativeOutboxPlan.object(snapshot),plan=try NativeOutboxPlan.object(raw)
    guard let registration=envelope["registration"] as? [String:Any],granted(registration),let original=envelope["request"] as? String,let request=try? NativeOutboxPlan.object(original),let echoed=plan["request"] as? [String:Any],try canonical(request)==canonical(echoed),let user=registration["user"] as? String,let type=request["type"] as? String,operations.contains(type) else{throw NativeOutboxPlan.Failure.invalid}
    try NativeOutboxPlan.fields(plan,["request","route","basis","target","publication"])
    let domains=registration["domains"] as! [String]
    guard plan["route"] as? String==(domains.contains("outbox") ? "outbox":"relay") else{throw NativeOutboxPlan.Failure.invalid}
    guard (plan["basis"] is NSNull || plan["basis"] is [String:Any]),(plan["target"] is NSNull || plan["target"] is [String:Any]),(plan["publication"] is NSNull || plan["publication"] is [String:Any]) else{throw NativeOutboxPlan.Failure.invalid}
    let basis=plan["basis"] as? [String:Any],target=plan["target"] as? [String:Any]
    if let basis{try signed(basis);guard try NativeOutboxPlan.integer(basis["kind"],maximum:65535)==3,basis["pubkey"] as? String==user else{throw NativeOutboxPlan.Failure.invalid}}
    if let target{try signed(target)}
    let publication=plan["publication"] as? [String:Any],event=(publication?["event"] as? [String:Any])?["event"] as? [String:Any]
    if let publication{guard publication["ancillary"] is NSNull,(publication["requiredInboxes"] as? [String])?.isEmpty==true else{throw NativeOutboxPlan.Failure.invalid}}
    let expected=try derive(request,basis,target,event?["created_at"])
    guard (event==nil)==(expected==nil) else{throw NativeOutboxPlan.Failure.invalid}
    guard let expected,let event,let publication else{return NativeCommonPlan(nil,nil)}
    guard try NativeOutboxPlan.unsigned(event,strict:true)==NativeOutboxPlan.unsigned(expected,strict:true) else{throw NativeOutboxPlan.Failure.invalid}
    let captured=try NativeOutboxPlan.capture(snapshot:snapshot,raw:canonical(publication),derived:expected)
    return NativeCommonPlan(captured,expected)
  }
  private static func derive(_ request:[String:Any],_ basis:[String:Any]?,_ target:[String:Any]?,_ created:Any?)throws->[String:Any]?{
    let type=request["type"] as! String;var tags:[[String]]=[],content="",kind:Int
    if type=="common.follow" || type=="common.unfollow"{
      try NativeOutboxPlan.fields(request,["type","id","pubkeys"])
      guard let values=request["pubkeys"] as? [String],(1...16).contains(values.count),target==nil else{throw NativeOutboxPlan.Failure.invalid}
      let keys=try values.map{try NativeCommonNpub.decode($0)},before=basis?["tags"] as? [[String]] ?? []
      tags=before.filter{!(type=="common.unfollow" && $0.first=="p" && $0.count>1 && keys.contains($0[1]))}
      if type=="common.follow"{for key in keys where !tags.contains(where:{$0.first=="p" && $0.count>1 && $0[1]==key}){tags.append(["p",key])}}
      if tags==before{return nil};content=basis?["content"] as? String ?? "";kind=3
      if let basis{guard try NativeOutboxPlan.integer(created,maximum:9007199254740991)>NativeOutboxPlan.integer(basis["created_at"],maximum:9007199254740991) else{throw NativeOutboxPlan.Failure.invalid}}
    }else if type=="common.react"{
      let fields:Set<String>=["type","id","targetEventId","reaction"]
      guard Set(request.keys)==fields || Set(request.keys)==fields.union(["customEmojiHref"]),basis==nil,let target,let id=target["id"] as? String,id==request["targetEventId"] as? String,let author=target["pubkey"] as? String,let value=request["reaction"] as? String,(1...256).contains(value.utf8.count) else{throw NativeOutboxPlan.Failure.invalid}
      content=value;kind=7;tags=[["e",id],["p",author]]
      let targetKind=try NativeOutboxPlan.integer(target["kind"],maximum:65535)
      if (30000...39999).contains(targetKind){let d=(target["tags"] as? [[String]])?.first(where:{$0.first=="d"})?.dropFirst().first ?? "";tags.append(["a","\(targetKind):\(author):\(d)"])}
      if value.range(of:"^:[A-Za-z0-9_-]{1,64}:$",options:.regularExpression) != nil{
        guard let href=request["customEmojiHref"] as? String,href.utf8.count<=2048,let url=URLComponents(string:href),url.scheme=="https",url.host != nil,url.user==nil,url.password==nil else{throw NativeOutboxPlan.Failure.invalid}
        tags.append(["emoji",String(value.dropFirst().dropLast()),href])
      }else if request["customEmojiHref"] != nil{throw NativeOutboxPlan.Failure.invalid}
    }else{
      try NativeOutboxPlan.fields(request,["type","id","target","reason","text"])
      guard basis==nil,let value=request["target"] as? [String:Any],Set(value.keys).isSubset(of:["type","id","pubkey","relay"]),let reason=request["reason"] as? String,["nudity","malware","profanity","illegal","spam","impersonation","other"].contains(reason),let text=request["text"] as? String,text.utf8.count<=4096 else{throw NativeOutboxPlan.Failure.invalid}
      let pubkeyTarget=value["type"] as? String=="pubkey",required:Set<String> = pubkeyTarget ? ["type","pubkey"]:["type","id"]
      guard Set(value.keys).isSuperset(of:required),Set(value.keys).isSubset(of:required.union(pubkeyTarget ? ["relay"]:["pubkey","relay"])) else{throw NativeOutboxPlan.Failure.invalid}
      if let relay=value["relay"]{guard let hint=relay as? String,hint.utf8.count<=2048 else{throw NativeOutboxPlan.Failure.invalid}}
      content=text;kind=1984
      if value["type"] as? String=="pubkey"{guard target==nil,let raw=value["pubkey"] as? String else{throw NativeOutboxPlan.Failure.invalid};tags=[["p",try NativeCommonNpub.publicKey(raw),reason]]}
      else{guard value["type"] as? String=="event",let target,let id=target["id"] as? String,id==value["id"] as? String,let author=target["pubkey"] as? String else{throw NativeOutboxPlan.Failure.invalid};if let raw=value["pubkey"] as? String{guard try NativeCommonNpub.publicKey(raw)==author else{throw NativeOutboxPlan.Failure.invalid}};tags=[["e",id,reason],["p",author]]}
    }
    return ["kind":kind,"created_at":try NativeOutboxPlan.integer(created,maximum:9007199254740991),"tags":tags,"content":content]
  }
  private static func signed(_ event:[String:Any])throws{
    try NativeOutboxPlan.fields(event,["kind","created_at","tags","content","id","pubkey","sig"])
    guard let user=event["pubkey"] as? String,NativeOutboxPlan.hex(user,64),let sig=event["sig"] as? String,NativeOutboxPlan.hex(sig,128),try NativeOutboxPlan.eventHash(event,identity:user)==event["id"] as? String else{throw NativeOutboxPlan.Failure.invalid}
  }
  static func canonical(_ value:Any)throws->String{String(decoding:try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes]),as:UTF8.self)}
}
