import Foundation
import zlib

/// Reject malformed metadata before codecs can silently ignore it.
enum UploadPhotoContainer {
  static func validatedType(_ input: Data) -> String? {
    let b = [UInt8](input)
    guard b.count >= 12 else { return nil }
    if b.starts(with: [0xff, 0xd8]) { return jpeg(b) ? "public.jpeg" : nil }
    if b.starts(with: [137,80,78,71,13,10,26,10]) { return png(b) ? "public.png" : nil }
    if ["GIF87a", "GIF89a"].contains(text(b, 0, 6)) {
      return b.count >= 14 && b.last == 59 ? "com.compuserve.gif" : nil
    }
    if text(b, 0, 4) == "RIFF" { return webp(b) ? "org.webmproject.webp" : nil }
    guard heicBrand(b), heic(b) else { return nil }
    return "public.heic"
  }

  private static func heicBrand(_ b: [UInt8]) -> Bool {
    guard text(b, 4, 4) == "ftyp" else { return false }
    let size = number(b, 0, false)
    guard size >= 16, size <= b.count, size % 4 == 0 else { return false }
    let brands: Set<String> = ["heic", "heix", "hevc", "hevx"]
    if brands.contains(text(b, 8, 4)) { return true }
    return stride(from: 16, to: size, by: 4).contains { brands.contains(text(b, $0, 4)) }
  }

  static func validate(_ input: Data, _ type: String) -> Bool {
    return validatedType(input) == type
  }
  static func cleanGeneratedPng(_ input: Data) -> Data? {
    guard validate(input, "public.png") else {return nil}
    let b = [UInt8](input); var output = Data(b.prefix(8)), at = 8
    let rendering: Set<String> = ["IHDR","PLTE","tRNS","IDAT","IEND","cHRM","gAMA","iCCP","sRGB","cICP","sBIT","bKGD","pHYs"]
    while at <= b.count - 12 {
      let size = number(b,at,false), tag = text(b,at+4,4)
      if rendering.contains(tag) {output.append(contentsOf:b[at..<at+size+12])}
      at += size + 12
    }
    return output
  }
  private static func jpeg(_ b: [UInt8]) -> Bool {
    guard b.count >= 4, b[0] == 255, b[1] == 216, b[b.count-2] == 255, b.last == 217 else {return false}
    var at = 2, count = 0, exif = false
    while at < b.count - 2 {
      guard b[at] == 255 else {return false}; at += 1
      while at < b.count && b[at] == 255 {at += 1}
      guard at < b.count else {return false}; let tag = b[at]; at += 1
      guard tag != 0 && tag != 216 && tag != 217 && !(208...215).contains(tag) else {return false}
      guard at <= b.count - 2 else {return false}
      let size = Int(b[at]) << 8 | Int(b[at+1]); count += 1
      guard size >= 2, size <= b.count - at, count <= 4096 else {return false}
      if tag == 225 && size >= 8 && text(b,at+2,6) == "Exif\0\0" {
        guard !exif, UploadExifMetadata.orientation(b,at+8,size-8) != nil else {return false}; exif = true
      }
      if tag == 218 {return true}; at += size
    }
    return false
  }
  private static func png(_ b: [UInt8]) -> Bool {
    guard b.count >= 57, Array(b.prefix(8)) == [137,80,78,71,13,10,26,10] else {return false}
    let allowed: Set<String> = ["IHDR","PLTE","tRNS","IDAT","IEND","cHRM","gAMA","iCCP","sRGB","cICP","sBIT","bKGD","pHYs","tEXt","zTXt","iTXt","tIME","eXIf"]
    var at = 8, count = 0, exif = false, pixels = false, endedPixels = false, header = false
    var seen = Set<String>()
    while at <= b.count - 12 {
      let size = number(b,at,false); guard size <= b.count - at - 12 else {return false}
      let tag = text(b,at+4,4); count += 1
      guard allowed.contains(tag), count <= 4096, (at != 8 || tag == "IHDR") else {return false}
      if tag == "IHDR" {guard !header, size == 13 else {return false}; header = true}
      if !["IDAT","tEXt","zTXt","iTXt"].contains(tag) {guard seen.insert(tag).inserted else {return false}}
      if tag == "PLTE" {guard !pixels, size >= 3, size <= 768, size % 3 == 0 else {return false}}
      if ["gAMA","cHRM","iCCP","sRGB","sBIT","cICP"].contains(tag) && pixels {return false}
      guard !(seen.contains("iCCP") && seen.contains("sRGB")) else {return false}
      let crc = b.withUnsafeBufferPointer { crc32(0, $0.baseAddress! + at + 4, uInt(size + 4)) }
      guard crc == number(b,at+8+size,false) else {return false}
      if tag == "eXIf" {guard !exif, UploadExifMetadata.orientation(b,at+8,size) != nil else {return false}; exif = true}
      if tag == "IDAT" {guard !endedPixels else {return false}; pixels = true} else if pixels {endedPixels = true}
      at += size + 12
      if tag == "IEND" {return pixels && size == 0 && at == b.count}
    }
    return false
  }
  private static func webp(_ b: [UInt8]) -> Bool {
    guard b.count >= 20, text(b,0,4) == "RIFF", text(b,8,4) == "WEBP", number(b,4,true) == b.count-8 else {return false}
    var at = 12, count = 0, exif = false, pixels = false
    while at <= b.count - 8 {
      let size = number(b,at+4,true), tag = text(b,at,4); count += 1
      guard size <= b.count - at - 8, count <= 4096, ["VP8 ","VP8L","VP8X","ALPH","ICCP","EXIF","XMP "].contains(tag) else {return false}
      if tag == "EXIF" {
        let prefix = size >= 6 && text(b,at+8,6) == "Exif\0\0" ? 6 : 0
        guard !exif, UploadExifMetadata.orientation(b,at+8+prefix,size-prefix) != nil else {return false}; exif = true
      }
      if tag == "VP8 " || tag == "VP8L" {guard !pixels else {return false}; pixels = true}
      at += size + 8 + (size & 1)
    }
    return at == b.count && pixels
  }
  private static func heic(_ b: [UInt8]) -> Bool {
    guard b.count >= 24, text(b,4,4) == "ftyp" else {return false}
    var at = 0, count = 0, metadata = false, pixels = false
    while at <= b.count - 8 {
      var size = number(b,at,false), header = 8; let tag = text(b,at+4,4); count += 1
      if size == 1 {guard at <= b.count-16, number(b,at+8,false) == 0 else {return false}; size = number(b,at+12,false); header = 16}
      if size == 0 {size = b.count-at}
      guard size >= header, size <= b.count-at, count <= 4096 else {return false}
      metadata = metadata || tag == "meta"; pixels = pixels || tag == "mdat"; at += size
    }
    return at == b.count && metadata && pixels
  }
  private static func text(_ b: [UInt8], _ at: Int, _ count: Int) -> String {String(bytes:b[at..<at+count],encoding:.isoLatin1) ?? ""}
  private static func number(_ b: [UInt8], _ at: Int, _ little: Bool) -> Int {
    var value = 0; for index in 0..<4 {value = value << 8 | Int(b[at + (little ? 3-index : index)])}; return value
  }
}
