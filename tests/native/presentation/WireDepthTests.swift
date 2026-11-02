import Foundation
@main @MainActor struct WireDepthTests {
 static var count = 0
 static func expect(_ value: Bool) {count += 1;precondition(value,"Wire depth assertion \(count)")}
 static func main() throws {
  let schema:[String:Any]=["type":"object","properties":["deep":["type":"object","properties":["child":["type":"object","properties":["leaf":["type":"object","properties":["values":["type":"array","items":["type":"string","enum":["native-depth-four"]],"default":["native-depth-four"]]]]]]]]]]
  let wrapper:[String:Any]=["type":"routing.call","id":"native-request","message":["type":"config.registerSchema","id":"sdk-request","schema":schema],"revision":1]
  let raw=try UploadWire.json(wrapper)
  expect((try? UploadWire.object(raw,limit:36*1024)) == nil)
  let captured=try UploadWire.object(raw,limit:36*1024,maximumDepth:40);expect(captured["id"] as? String == "native-request")
  expect(NSDictionary(dictionary:captured["message"] as! [String:Any]).isEqual(to:wrapper["message"] as! [String:Any]))
  let snapshot = try UploadWire.json(["registration": ["user":"01"], "request":raw])
  let access = try IdentityListAccess().captureJSON(snapshot); expect(access == nil)
  for depth in [12,13,40,41] {
   let value=String(repeating:"[",count:depth)+"0"+String(repeating:"]",count:depth)
   expect(UploadWire.boundedJSON(value,limit:1000) == (depth<=12))
   expect(UploadWire.boundedJSON(value,limit:1000,maximumDepth:40) == (depth<=40))
  }
  expect(!UploadWire.boundedJSON("{}",limit:100,maximumDepth:41));expect(!UploadWire.boundedJSON("{}",limit:100,maximumDepth:0))
  expect(!UploadWire.boundedJSON(raw,limit:10,maximumDepth:40));expect(!UploadWire.boundedJSON("{]}",limit:100,maximumDepth:40));expect(!UploadWire.boundedJSON("{\"x\":\"unterminated}",limit:100,maximumDepth:40))
  expect(UploadWire.boundedJSON("{\"x\":\"[{}]\"}",limit:100,maximumDepth:1))
  print("iOS real UploadWire \(count) bounded routing/upload carrier assertions passed")
 }
}
