import Foundation
import zlib

/// Strips non-rendering metadata without rewriting PNG pixel or supported color chunks.
enum UploadPngMetadata {
  private static let signature: [UInt8] = [137,80,78,71,13,10,26,10]
  private static let content: Set<String> = ["IHDR", "IDAT", "IEND", "sRGB", "gAMA", "cHRM"]
  private static let text: Set<String> = ["tEXt", "zTXt", "iTXt"]
  static func prepare(_ input: Data) -> Data? {
    guard (57...NativeUploadAuthority.maxBytes).contains(input.count) else { return nil }
    let bytes = [UInt8](input); guard Array(bytes.prefix(8)) == signature else { return nil }
    var output = Data(signature), cursor = 8, chunks = 0, pixels = false, endedPixels = false, ended = false, exif = false, time = false
    while cursor <= bytes.count - 12 {
      chunks += 1; guard chunks <= 4096, !ended else { return nil }
      let rawLength = number(bytes, cursor, false); guard rawLength <= UInt32(bytes.count - cursor - 12) else { return nil }
      let length = Int(rawLength), start = cursor + 8, type = String(decoding: bytes[(cursor + 4)..<(cursor + 8)], as: UTF8.self)
      guard type.range(of: "^[A-Za-z]{2}[A-Z][A-Za-z]$", options: .regularExpression) != nil,
        cursor != 8 || type == "IHDR", crc(bytes, cursor + 4, length + 4) == number(bytes, start + length, false) else { return nil }
      if type == "IDAT" {guard !endedPixels else { return nil }; pixels = true} else if pixels {endedPixels = true}
      if content.contains(type) {output.append(contentsOf: bytes[cursor..<(cursor + length + 12)])}
      else if text.contains(type) { /* Dropped without inflating potentially hostile compressed text. */ }
      else if type == "eXIf" {
        guard !exif, neutralOrientation(bytes, start, length) else { return nil }; exif = true
      } else if type == "tIME" {
        guard !time, length == 7, (1...12).contains(bytes[start + 2]), (1...31).contains(bytes[start + 3]),
          bytes[start + 4] <= 23, bytes[start + 5] <= 59, bytes[start + 6] <= 60 else { return nil }; time = true
      } else { return nil }
      cursor += length + 12
      if type == "IEND" {guard cursor == bytes.count else { return nil }; ended = true}
    }
    return ended && cursor == bytes.count ? UploadPngProfile.prepare(output) : nil
  }
  private static func neutralOrientation(_ bytes: [UInt8], _ start: Int, _ length: Int) -> Bool {
    guard length >= 14 else { return false }
    let little = bytes[start] == 73 && bytes[start + 1] == 73
    guard little || (bytes[start] == 77 && bytes[start + 1] == 77), shortNumber(bytes, start + 2, little) == 42 else { return false }
    let offset = Int(number(bytes, start + 4, little)); guard offset >= 8, offset <= length - 6 else { return false }
    let directory = start + offset, count = Int(shortNumber(bytes, directory, little))
    guard count <= 128, count * 12 + 6 <= length - offset else { return false }
    var orientation = false, tags = Set<UInt16>()
    let widths: [UInt64] = [0,1,1,2,4,8,1,1,2,4,8,4,8]
    for index in 0..<count {
      let entry = directory + 2 + index * 12
      let tag = shortNumber(bytes, entry, little), type = Int(shortNumber(bytes, entry + 2, little))
      let values = UInt64(number(bytes, entry + 4, little))
      guard tags.insert(tag).inserted, (1..<widths.count).contains(type), values > 0 else { return false }
      let size = values * widths[type]
      if size > 4 {
        let position = UInt64(number(bytes, entry + 8, little))
        guard position >= 8, position <= UInt64(length), size <= UInt64(length) - position else { return false }
      }
      if tag == 274 {
        guard !orientation, shortNumber(bytes, entry + 2, little) == 3, number(bytes, entry + 4, little) == 1,
          shortNumber(bytes, entry + 8, little) == 1 else { return false }; orientation = true
      }
    }
    return number(bytes, directory + 2 + count * 12, little) == 0
  }
  private static func shortNumber(_ bytes: [UInt8], _ offset: Int, _ little: Bool) -> UInt16 {
    little ? UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8 : UInt16(bytes[offset]) << 8 | UInt16(bytes[offset + 1])
  }
  private static func number(_ bytes: [UInt8], _ offset: Int, _ little: Bool) -> UInt32 {
    var result: UInt32 = 0
    for index in 0..<4 {result = result << 8 | UInt32(bytes[offset + (little ? 3 - index : index)])}
    return result
  }
  private static func crc(_ bytes: [UInt8], _ offset: Int, _ length: Int) -> UInt32 {
    bytes.withUnsafeBytes { buffer in
      UInt32(crc32(0, buffer.baseAddress!.advanced(by: offset).assumingMemoryBound(to: UInt8.self), uInt(length)))
    }
  }
}
