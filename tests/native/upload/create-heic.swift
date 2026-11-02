import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let root = URL(fileURLWithPath:CommandLine.arguments[1]);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
for gamut in ["srgb","p3"] {
 let colors:[[UInt8]]=[[240,20,20,255],[20,230,30,255],[20,40,240,255],[235,210,20,255]]
 var bytes=[UInt8]();for y in 0..<256 {for x in 0..<512 {bytes.append(contentsOf:colors[(y>=128 ? 2 : 0)+(x>=256 ? 1 : 0)])}}
 let space=CGColorSpace(name:gamut == "srgb" ? CGColorSpace.sRGB : CGColorSpace.displayP3)!
 let provider=CGDataProvider(data:Data(bytes) as CFData)!
 let image=CGImage(width:512,height:256,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:2048,space:space,bitmapInfo:CGBitmapInfo(rawValue:CGImageAlphaInfo.noneSkipLast.rawValue),provider:provider,decode:nil,shouldInterpolate:false,intent:.defaultIntent)!
 for orientation in [1,6] {
  let file=root.appendingPathComponent("heic-\(gamut)-orientation-\(orientation).heic")
  guard let dest=CGImageDestinationCreateWithURL(file as CFURL,UTType.heic.identifier as CFString,1,nil) else {fatalError("HEIC encoding unavailable")}
  CGImageDestinationAddImage(dest,image,[kCGImageDestinationLossyCompressionQuality:0.85,kCGImagePropertyOrientation:orientation,kCGImagePropertyTIFFDictionary:[kCGImagePropertyTIFFMake:"Public test camera",kCGImagePropertyTIFFImageDescription:"Public photo picker HEIC proof",kCGImagePropertyTIFFDateTime:"2026:01:02 03:04:05"],kCGImagePropertyGPSDictionary:[kCGImagePropertyGPSLatitude:1.234,kCGImagePropertyGPSLatitudeRef:"N",kCGImagePropertyGPSLongitude:4.567,kCGImagePropertyGPSLongitudeRef:"E"]] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else {fatalError("HEIC finalize failed")}
 }
 let png=root.appendingPathComponent("reference-\(gamut).png");let dest=CGImageDestinationCreateWithURL(png as CFURL,UTType.png.identifier as CFString,1,nil)!
 CGImageDestinationAddImage(dest,image,nil);guard CGImageDestinationFinalize(dest) else {fatalError("PNG finalize failed")}
}
