import Foundation
import ImageIO
import UniformTypeIdentifiers
@main struct Proof {
 static func main() throws {
  let root=URL(fileURLWithPath:CommandLine.arguments[1]),out=URL(fileURLWithPath:CommandLine.arguments[2]);try FileManager.default.createDirectory(at:out,withIntermediateDirectories:true)
  let manifest=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("photos.json"))) as! [String:Any]
  var checks=0
  for item in manifest["files"] as! [[String:Any]] {
   let name=item["file"] as! String,data=try Data(contentsOf:root.appendingPathComponent(name))
   guard let result=UploadPhotoPreparation.prepare(data),result.mimeType=="image/png",result.metadataPolicy=="photo-stripped" else {fatalError("valid denied: "+name)};checks += 1
   guard let repeated=UploadPhotoPreparation.prepare(result.bytes), repeated.bytes==result.bytes else {fatalError("not idempotent: "+name)};checks += 1
   try result.bytes.write(to:out.appendingPathComponent(name+".png"))
   guard let source=CGImageSourceCreateWithData(data as CFData,nil),let visible=CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary),
    let destination=CGImageDestinationCreateWithURL(out.appendingPathComponent(name+".source.png") as CFURL,UTType.png.identifier as CFString,1,nil) else {fatalError("Source decode reference failed")}
   CGImageDestinationAddImage(destination,visible,nil);guard CGImageDestinationFinalize(destination) else {fatalError("Source decode encoding failed")}
  }
  for item in manifest["invalid"] as! [[String:Any]] {
   let name=item["file"] as! String;guard UploadPhotoPreparation.prepare(try Data(contentsOf:root.appendingPathComponent(name)))==nil else {fatalError("invalid admitted: "+name)};checks += 1
  }
  print("PASS ImageIO native owning photo checks: \(checks)")
 }
}
