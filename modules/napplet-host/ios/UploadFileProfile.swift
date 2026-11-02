import Foundation

/// Supported attachment signatures are native-owned; a failed photo never falls through.
enum UploadFileProfile {
  struct Prepared: Sendable {let bytes: Data; let mimeType: String; let metadataPolicy: String}
  static func prepare(_ input: Data) -> Prepared? {
    guard (1...NativeUploadAuthority.maxBytes).contains(input.count) else {return nil}
    let bytes = [UInt8](input)
    if bytes.count >= 8, bytes[0] == 137, text(bytes, 1, 3) == "PNG" {
      guard let safe = UploadPngMetadata.prepare(input) else {return nil}
      return Prepared(bytes: safe, mimeType: "image/png", metadataPolicy: "photo-stripped")
    }
    guard let type = attachmentType(bytes) else {return nil}
    return Prepared(bytes: input, mimeType: type, metadataPolicy: "attachment-unchanged")
  }
  static func attachmentType(_ bytes: [UInt8]) -> String? {
    guard (1...NativeUploadAuthority.maxBytes).contains(bytes.count) else {return nil}
    if bytes.count >= 12, text(bytes, 0, 4) == "RIFF" {
      guard text(bytes, 8, 4) == "WAVE", number(bytes, 4, true) == bytes.count - 8 else {return nil}
      var cursor = 12, chunks = 0, format = false, data = false
      while cursor <= bytes.count - 8 {
        chunks += 1; guard chunks <= 4096 else {return nil}
        let length = number(bytes, cursor + 4, true); guard length <= bytes.count - cursor - 8 else {return nil}
        let tag = text(bytes, cursor, 4)
        if tag == "fmt " {guard !format, length >= 16 else {return nil}; format = true}
        if tag == "data" {guard !data, length >= 1 else {return nil}; data = true}
        cursor += 8 + length + (length & 1)
      }
      return cursor == bytes.count && format && data ? "audio/wav" : nil
    }
    if bytes.count >= 12, text(bytes, 4, 4) == "ftyp" {
      let first = number(bytes, 0, false); guard first >= 16, first <= bytes.count, (first - 16) % 4 == 0 else {return nil}
      let brands: Set<String> = ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "]
      guard brands.contains(text(bytes, 8, 4)) else {return nil}
      for at in stride(from: 16, to: first, by: 4) {guard brands.contains(text(bytes, at, 4)) else {return nil}}
      var cursor = 0, boxes = 0, movie = false, data = false
      while cursor <= bytes.count - 8 {
        boxes += 1; guard boxes <= 4096 else {return nil}
        var size = number(bytes, cursor, false), header = 8
        if size == 1 {
          guard cursor <= bytes.count - 16, number(bytes, cursor + 8, false) == 0 else {return nil}
          size = number(bytes, cursor + 12, false); header = 16
        }
        if size == 0 {size = bytes.count - cursor}
        guard size >= header, size <= bytes.count - cursor else {return nil}
        let tag = text(bytes, cursor + 4, 4); movie = movie || tag == "moov"; data = data || tag == "mdat"; cursor += size
      }
      return cursor == bytes.count && movie && data ? "video/mp4" : nil
    }
    if bytes.count >= 10, text(bytes, 0, 3) == "ID3" {
      guard (2...4).contains(bytes[3]) else {return nil}
      var length = 0; for at in 6..<10 {guard bytes[at] < 128 else {return nil}; length = length << 7 | Int(bytes[at])}
      let offset = length + 10 + ((bytes[3] == 4 && bytes[5] & 16 != 0) ? 10 : 0)
      return mp3(bytes, offset) ? "audio/mpeg" : nil
    }
    if mp3(bytes, 0) {return "audio/mpeg"}
    if bytes.count >= 12, text(bytes, 0, 5) == "%PDF-",
      (text(bytes, 5, 3).range(of: "^1\\.[0-9]$", options: .regularExpression) != nil || text(bytes, 5, 3) == "2.0"),
      text(bytes, max(0, bytes.count - 1024), min(1024, bytes.count)).contains("%%EOF") {return "application/pdf"}
    if bytes.count >= 22, bytes[0] == 80, bytes[1] == 75,
      ((bytes[2] == 3 && bytes[3] == 4) || (bytes[2] == 5 && bytes[3] == 6)) {return "application/zip"}
    guard bytes.count <= 1024 * 1024, let value = String(bytes: bytes, encoding: .utf8) else {return nil}
    let start = value.replacingOccurrences(of: "\u{FEFF}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !start.isEmpty, !start.hasPrefix("<"), !start.hasPrefix("GIF8"), !start.hasPrefix("II*"), !start.hasPrefix("MM") else {return nil}
    guard !bytes.contains(where: {$0 < 32 && ![9,10,13].contains($0) || $0 == 127}) else {return nil}
    return "text/plain"
  }
  private static func mp3(_ bytes: [UInt8], _ offset: Int) -> Bool {
    guard offset >= 0, offset <= bytes.count - 4 else {return false}
    let a = bytes[offset + 1], b = bytes[offset + 2]
    return bytes[offset] == 255 && a & 224 == 224 && a & 24 != 8 && a & 6 != 0 && b >> 4 != 0 && b >> 4 != 15 && b & 12 != 12
  }
  private static func text(_ bytes: [UInt8], _ offset: Int, _ length: Int) -> String {String(bytes: bytes[offset..<(offset + length)], encoding: .isoLatin1) ?? ""}
  private static func number(_ bytes: [UInt8], _ offset: Int, _ little: Bool) -> Int {
    var value = 0; for index in 0..<4 {value = value << 8 | Int(bytes[offset + (little ? 3 - index : index)])}; return value
  }
}
