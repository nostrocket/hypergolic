import Foundation
import ImageIO
import zlib

/// First tracer only: unchanged bounded 8-bit RGB/RGBA PNG containing no embedded photo metadata.
/// EXIF/ICC/unknown chunks and animation await the full photo preparer; no silent orientation/color downgrade.
enum UploadPngProfile {
  static func prepare(_ input: Data) -> Data? {
    let bytes = [UInt8](input)
    guard (57...NativeUploadAuthority.maxBytes).contains(bytes.count),
      Array(bytes.prefix(8)) == [137,80,78,71,13,10,26,10] else { return nil }
    var cursor = 8, width = 0, height = 0, header = false, pixels = false, endedPixels = false, end = false
    var seen = Set<String>(), compressed = Data()
    while cursor <= bytes.count - 12 {
      let rawLength = u32(bytes, cursor)
      guard rawLength <= UInt32(bytes.count - cursor - 12) else { return nil }
      let length = Int(rawLength), type = String(decoding: bytes[(cursor + 4)..<(cursor + 8)], as: UTF8.self)
      guard crc(bytes, cursor + 4, length + 4) == u32(bytes, cursor + 8 + length),
        (header || type == "IHDR"), !end else { return nil }
      if pixels && type != "IDAT" { endedPixels = true }
      switch type {
      case "IHDR":
        guard !header, length == 13 else { return nil }
        width = Int(u32(bytes, cursor + 8)); height = Int(u32(bytes, cursor + 12))
        guard (1...4096).contains(width), (1...4096).contains(height), width * height <= 4_194_304,
          bytes[cursor + 16] == 8, [2,6].contains(bytes[cursor + 17]), bytes[cursor + 18] == 0,
          bytes[cursor + 19] == 0, bytes[cursor + 20] == 0 else { return nil }
        header = true
      case "sRGB":
        guard !pixels, length == 1, bytes[cursor + 8] <= 3, seen.insert(type).inserted else { return nil }
      case "gAMA":
        guard !pixels, length == 4, u32(bytes, cursor + 8) > 0, seen.insert(type).inserted else { return nil }
      case "cHRM":
        guard !pixels, length == 32, seen.insert(type).inserted else { return nil }
      case "IDAT":
        guard header, !endedPixels else { return nil }; pixels = true
        compressed.append(contentsOf: bytes[(cursor + 8)..<(cursor + 8 + length)])
      case "IEND":
        guard pixels, length == 0, cursor + 12 == bytes.count else { return nil }; end = true
      default: return nil
      }
      cursor += length + 12
    }
    guard end, cursor == bytes.count, validPixels(compressed, width, height, Int(bytes[25] == 2 ? 3 : 4)), let source = CGImageSourceCreateWithData(input as CFData, nil),
      CGImageSourceGetCount(source) == 1,
      let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
      image.width == width, image.height == height else { return nil }
    return input
  }
  private static func validPixels(_ data: Data, _ width: Int, _ height: Int, _ channels: Int) -> Bool {
    var input = [UInt8](data), scratch = [UInt8](repeating: 0, count: 64 * 1024), stream = z_stream()
    guard inflateInit_(&stream, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return false }
    defer { inflateEnd(&stream) }
    let row = width * channels + 1, expected = row * height
    return input.withUnsafeMutableBytes { inputBuffer in
      stream.next_in = inputBuffer.bindMemory(to: UInt8.self).baseAddress; stream.avail_in = uInt(inputBuffer.count)
      var total = 0
      return scratch.withUnsafeMutableBytes { outputBuffer in
        while true {
          stream.next_out = outputBuffer.bindMemory(to: UInt8.self).baseAddress; stream.avail_out = uInt(outputBuffer.count)
          let status = inflate(&stream, Z_NO_FLUSH), count = outputBuffer.count - Int(stream.avail_out)
          guard (status == Z_OK || status == Z_STREAM_END), count > 0, count <= expected - total else { return false }
          let output = outputBuffer.bindMemory(to: UInt8.self)
          for index in 0..<count where (total + index) % row == 0 { if output[index] > 4 { return false } }
          total += count
          if status == Z_STREAM_END { return total == expected && stream.avail_in == 0 }
        }
      }
    }
  }
  private static let crcTable: [UInt32] = (0..<256).map { value in
    var result = UInt32(value)
    for _ in 0..<8 { result = result & 1 == 0 ? result >> 1 : (result >> 1) ^ 0xedb88320 }
    return result
  }
  private static func crc(_ bytes: [UInt8], _ start: Int, _ length: Int) -> UInt32 {
    var result: UInt32 = 0xffffffff
    for index in start..<(start + length) { result = crcTable[Int((result ^ UInt32(bytes[index])) & 255)] ^ (result >> 8) }
    return result ^ 0xffffffff
  }
  private static func u32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
    UInt32(bytes[offset]) << 24 | UInt32(bytes[offset + 1]) << 16 | UInt32(bytes[offset + 2]) << 8 | UInt32(bytes[offset + 3])
  }
}
