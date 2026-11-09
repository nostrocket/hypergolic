import Foundation
@main struct ConfigurationProof {
  static func main() throws {
    var count=0
    func check(_ value:Bool){precondition(value);count+=1}
    func raw(_ row:[String:Any])throws->String{String(decoding:try JSONSerialization.data(withJSONObject:row),as:UTF8.self)}
    var input:[String:Any]=["sessionId":"session","instanceId":"instance","epoch":1,"user":String(repeating:"1",count:64),"publisher":String(repeating:"2",count:64),"appId":"test","version":String(repeating:"3",count:64),"fixture":"published","domains":["common","identity","outbox","cvm","media"],"commonProfile":"social-v1","cvmProfile":"free-foreground-v1","mediaProfile":"finite-live-mp3-v1"]
    let current=try CapabilityConfiguration(raw(input),generation:"generation")
    check(current.commonProfile=="social-v1" && current.cvmProfile=="free-foreground-v1" && current.mediaProfile=="finite-live-mp3-v1")
    let snapshot=try JSONSerialization.jsonObject(with:Data(current.snapshot.utf8))as![String:Any]
    for key in ["commonProfile","cvmProfile","mediaProfile"]{check(snapshot[key]as?String==input[key]as?String)}
    for invalid:Any in [true,1,"unknown",NSNull(),[String:Any]()]{var row=input;row["mediaProfile"]=invalid;check((try? CapabilityConfiguration(raw(row),generation:"invalid"))==nil)}
    var missing=input;missing["domains"]=["common","identity","outbox","cvm"];check((try? CapabilityConfiguration(raw(missing),generation:"missing"))==nil)
    input.removeValue(forKey:"mediaProfile")
    let old=try CapabilityConfiguration(raw(input),generation:"old")
    check(old.mediaProfile==nil && old.commonProfile=="social-v1" && old.cvmProfile=="free-foreground-v1")
    print("LiveMP3ConfigurationProof: \(count) checks passed (actual extracted configuration struct)")
  }
}
