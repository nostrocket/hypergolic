import Foundation

/// Bounded TIFF/Exif validation. Discarded personal fields never enter prepared output.
enum UploadExifMetadata {
  private struct Directory {let offset: Int; let primary: Bool}
  private static let widths: [UInt64] = [0,1,1,2,4,8,1,1,2,4,8,4,8]
  /// Primary orientation 1...8, or nil for invalid/unsupported metadata.
  static func orientation(_ bytes: [UInt8], _ start: Int, _ length: Int) -> Int? {
    guard start >= 0, (14...256 * 1024).contains(length), start <= bytes.count - length else {return nil}
    let little = bytes[start] == 73 && bytes[start + 1] == 73
    guard little || (bytes[start] == 77 && bytes[start + 1] == 77), shortNumber(bytes, start + 2, little) == 42 else {return nil}
    let first = Int(number(bytes, start + 4, little)); guard first >= 8, first <= length - 6 else {return nil}
    var pending = [Directory(offset: first, primary: true)], seen = Set<Int>(), orientation = 1, total = 0, cursor = 0
    while cursor < pending.count {
      let item = pending[cursor]; cursor += 1; let offset = item.offset
      guard seen.count < 32, seen.insert(offset).inserted, offset >= 8, offset <= length - 6 else {return nil}
      let directory = start + offset, count = Int(shortNumber(bytes, directory, little)); total += count
      guard count <= 128, total <= 1024, count * 12 + 6 <= length - offset else {return nil}
      var tags = Set<UInt16>(), thumbnailOffset: Int?, thumbnailLength: Int?
      for index in 0..<count {
        let entry = directory + 2 + index * 12, tag = shortNumber(bytes, entry, little), type = Int(shortNumber(bytes, entry + 2, little))
        let values = UInt64(number(bytes, entry + 4, little)), value = UInt64(number(bytes, entry + 8, little))
        guard tags.insert(tag).inserted, (1..<widths.count).contains(type), values > 0 else {return nil}
        let size = values * widths[type]
        if size > 4 {guard value >= 8, value <= UInt64(length), size <= UInt64(length) - value else {return nil}}
        if tag == 274 {
          let rotation = Int(shortNumber(bytes, entry + 8, little))
          guard type == 3, values == 1, (1...8).contains(rotation) else {return nil}
          if item.primary {orientation = rotation}
        }
        if [34665,34853,40965].contains(tag) {
          guard type == 4, values == 1, value >= 8, value <= UInt64(length - 6) else {return nil}
          pending.append(Directory(offset: Int(value), primary: false))
        }
        if tag == 513 || tag == 514 {
          guard type == 4, values == 1 else {return nil}
          if tag == 513 {thumbnailOffset = Int(value)} else {thumbnailLength = Int(value)}
        }
      }
      if thumbnailOffset != nil || thumbnailLength != nil {
        guard let position = thumbnailOffset, let count = thumbnailLength, position >= 8, count >= 4, position <= length, count <= length - position else {return nil}
        let from = start + position, to = from + count
        guard bytes[from] == 255, bytes[from + 1] == 216, bytes[to - 2] == 255, bytes[to - 1] == 217 else {return nil}
      }
      let next = Int(number(bytes, directory + 2 + count * 12, little))
      if next != 0 {guard next >= 8, next <= length - 6 else {return nil}; pending.append(Directory(offset: next, primary: false))}
    }
    return orientation
  }
  private static func shortNumber(_ bytes: [UInt8], _ offset: Int, _ little: Bool) -> UInt16 {
    little ? UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8 : UInt16(bytes[offset]) << 8 | UInt16(bytes[offset + 1])
  }
  private static func number(_ bytes: [UInt8], _ offset: Int, _ little: Bool) -> UInt32 {
    var result: UInt32 = 0
    for index in 0..<4 {result = result << 8 | UInt32(bytes[offset + (little ? 3 - index : index)])}
    return result
  }
}
