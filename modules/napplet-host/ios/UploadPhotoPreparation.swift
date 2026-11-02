import Foundation
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

/// Fresh lossless PNG pixels; only canonical rendering profiles enter the output.
enum UploadPhotoPreparation {
  static func prepare(_ input: Data) -> UploadFileProfile.Prepared? {
    let existing = UploadFileProfile.prepare(input)
    if let existing, existing.metadataPolicy == "attachment-unchanged" {return existing}
    guard !input.isEmpty, input.count <= NativeUploadAuthority.maxBytes,
      let source = CGImageSourceCreateWithData(input as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetStatus(source) == .statusComplete, CGImageSourceGetCount(source) == 1,
      CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeHDRGainMap) == nil,
      CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeISOGainMap) == nil,
      let rawType = CGImageSourceGetType(source),
      ["public.jpeg", "public.png", "com.compuserve.gif", "org.webmproject.webp", "public.heic"].contains(rawType as String),
      UploadPhotoContainer.validate(input, rawType as String),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      (1...4096).contains(width), (1...4096).contains(height), width * height <= 4_194_304 else {return nil}
    if let existing {return existing}
    let orientation = (properties[kCGImagePropertyOrientation] as? Int) ?? 1
    guard (1...8).contains(orientation),
      let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true, kCGImageSourceShouldAllowFloat: false] as CFDictionary),
      image.width == width, image.height == height, image.bitsPerComponent == 8 else {return nil}
    let decoded: CGImage
    if image.colorSpace?.model == .indexed, rawType as String == "com.compuserve.gif" {
      guard let space = CGColorSpace(name: CGColorSpace.sRGB),
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {return nil}
      context.interpolationQuality = .none; context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      guard let expanded = context.makeImage() else {return nil}; decoded = expanded
    } else {decoded = image}
    guard let sourceColor = decoded.colorSpace,
      let canonical = [CGColorSpace.sRGB, CGColorSpace.displayP3].compactMap({CGColorSpace(name: $0)}).first(where: {CFEqual($0, sourceColor)}),
      let pixels = orient(decoded, orientation, canonical) else {return nil}
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else {return nil}
    CGImageDestinationAddImage(destination, pixels, nil)
    guard CGImageDestinationFinalize(destination), output.length <= NativeUploadAuthority.maxBytes else {return nil}
    guard let safe = UploadPhotoContainer.cleanGeneratedPng(output as Data) else {return nil}
    return UploadFileProfile.Prepared(bytes: safe, mimeType: "image/png", metadataPolicy: "photo-stripped")
  }

  /// Permute complete decoded pixel groups; no sampling, resizing or thumbnail path.
  private static func orient(_ image: CGImage, _ orientation: Int, _ space: CGColorSpace) -> CGImage? {
    if orientation == 1 {return image.copy(colorSpace: space)}
    guard [24,32].contains(image.bitsPerPixel), !image.bitmapInfo.contains(.floatComponents),
      let data = image.dataProvider?.data else {return nil}
    let width = image.width, height = image.height, pixel = image.bitsPerPixel / 8
    let outWidth = orientation >= 5 ? height : width, outHeight = orientation >= 5 ? width : height
    guard image.bytesPerRow >= width * pixel, CFDataGetLength(data) >= (height - 1) * image.bytesPerRow + width * pixel else {return nil}
    let source = CFDataGetBytePtr(data)!
    var output = Data(count: outWidth * outHeight * pixel)
    output.withUnsafeMutableBytes { storage in
      let target = storage.bindMemory(to: UInt8.self)
      for y in 0..<height {for x in 0..<width {
        let dx: Int, dy: Int
        switch orientation {
        case 2: dx = width - 1 - x; dy = y
        case 3: dx = width - 1 - x; dy = height - 1 - y
        case 4: dx = x; dy = height - 1 - y
        case 5: dx = y; dy = x
        case 6: dx = height - 1 - y; dy = x
        case 7: dx = height - 1 - y; dy = width - 1 - x
        case 8: dx = y; dy = width - 1 - x
        default: return
        }
        for channel in 0..<pixel {target[(dy * outWidth + dx) * pixel + channel] = source[y * image.bytesPerRow + x * pixel + channel]}
      }}
    }
    guard let provider = CGDataProvider(data: output as CFData) else {return nil}
    return CGImage(width: outWidth, height: outHeight, bitsPerComponent: 8, bitsPerPixel: image.bitsPerPixel, bytesPerRow: outWidth * pixel, space: space, bitmapInfo: image.bitmapInfo, provider: provider, decode: nil, shouldInterpolate: false, intent: image.renderingIntent)
  }
}
