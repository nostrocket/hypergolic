import Foundation

/// Selected finite, self-contained ISO BMFF H.264 and MPEG-4 audio sample profile.
struct FiniteMP4 {
  private let file: FileHandle
  private let length: Int
  private let check: () throws -> Void
  private var window = Data()
  private var origin = -1
  private var remaining = 4096
  private var movie = false, duration = false, data = false, video = false
  private static let brands = Set(["isom", "iso2", "mp41", "mp42", "avc1", "M4V "])
  private static let top = Set(["ftyp", "moov", "mdat", "free", "skip", "wide"])
  private static let containers = Set(["moov", "trak", "mdia", "minf", "dinf", "stbl"])
  private static let codecs = Set(["avc1", "avc3", "mp4a"])
  private static let forbidden = Set(["rmra", "mvex", "pssh", "sinf", "uuid"])
  private struct Box { let type: String; let start: Int; let end: Int }
  private struct Track { var references = false; var descriptions = false }

  static func accepts(_ url: URL, check: @escaping () throws -> Void) -> Bool {
    do {
      let file = try FileHandle(forReadingFrom: url)
      defer { try? file.close() }
      let end = try file.seekToEnd()
      guard (24...UInt64(MediaHTTPSFile.maximumBytes)).contains(end) else { return false }
      var profile = FiniteMP4(file: file, length: Int(end), check: check)
      guard let first = try profile.box(0, Int(end)), first.type == "ftyp", first.start == 8,
        (16...256).contains(first.end), (first.end - 16) % 4 == 0,
        brands.contains(try profile.tag(8)) else { return false }
      var track: Track?
      return try profile.visit(0, Int(end), 0, "", &track) && profile.movie && profile.duration && profile.data && profile.video
    } catch { return false }
  }
  static func validDimensions(_ width: Double, _ height: Double) -> Bool {
    width.isFinite && height.isFinite && width > 0 && height > 0 && min(width, height) <= 2160 && max(width, height) <= 3840
  }
  private mutating func bytes(_ at: Int, count: Int) throws -> Data.SubSequence {
    guard at >= 0, count <= length - at else { throw MediaHTTPSFile.Failure.invalidVideo }
    if origin < 0 || at < origin || count > window.count - (at - origin) {
      try check()
      try file.seek(toOffset: UInt64(at))
      let available = min(8192, length - at)
      guard let next = try file.read(upToCount: available), next.count == available else { throw MediaHTTPSFile.Failure.invalidVideo }
      window = next; origin = at
    }
    let offset = at - origin
    return window[offset..<offset + count]
  }
  private mutating func tag(_ start: Int) throws -> String {
    try String(decoding: bytes(start, count: 4), as: UTF8.self)
  }
  private mutating func uint(_ start: Int) throws -> Int {
    try bytes(start, count: 4).reduce(0) { ($0 << 8) | Int($1) }
  }
  private mutating func box(_ at: Int, _ end: Int) throws -> Box? {
    remaining -= 1
    guard remaining >= 0, end - at >= 8 else { return nil }
    var size = try uint(at), header = 8
    if size == 1 {
      guard end - at >= 16, try uint(at + 8) == 0 else { return nil }
      size = try uint(at + 12); header = 16
    } else if size == 0 { size = end - at }
    guard size >= header, size <= end - at else { return nil }
    return Box(type: try tag(at + 4), start: at + header, end: at + size)
  }
  private mutating func visit(_ start: Int, _ end: Int, _ depth: Int, _ parent: String, _ track: inout Track?) throws -> Bool {
    guard depth <= 6 else { return false }
    var at = start
    while at < end {
      guard let box = try box(at, end), !Self.forbidden.contains(box.type), depth != 0 || Self.top.contains(box.type) else { return false }
      if Self.containers.contains(box.type), !Self.properParent(box.type, parent) { return false }
      if box.type == "moov" { guard depth == 0, !movie else { return false }; movie = true }
      if box.type == "mdat" { guard depth == 0, box.start < box.end else { return false }; data = true }
      if box.type == "mvhd" {
        guard parent == "moov", !duration, try validDuration(box) else { return false }
        duration = true
      }
      if box.type == "trak" {
        guard depth == 1 else { return false }
        var next: Track? = Track()
        guard try visit(box.start, box.end, depth + 1, box.type, &next), next?.references == true, next?.descriptions == true else { return false }
      } else if Self.containers.contains(box.type) {
        guard try visit(box.start, box.end, depth + 1, box.type, &track) else { return false }
      } else if box.type == "dref" || box.type == "stsd" {
        guard parent == (box.type == "dref" ? "dinf" : "stbl"), var value = track, try entries(box, box.type == "dref", &value) else { return false }
        track = value
      }
      at = box.end
    }
    return true
  }
  private mutating func validDuration(_ box: Box) throws -> Bool {
    let at = box.start
    guard box.end - at >= 20 else { return false }
    let version = try uint(at) >> 24
    guard version == 0 || version == 1 && box.end - at >= 32 else { return false }
    let scale = try uint(at + (version == 0 ? 12 : 20))
    let ticks = try bytes(at + (version == 0 ? 16 : 24), count: version == 0 ? 4 : 8)
      .reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    return scale > 0 && ticks > 0 && ticks <= UInt64(scale) * 3600
  }
  private static func properParent(_ type: String, _ parent: String) -> Bool {
    switch type {
    case "moov": return parent.isEmpty
    case "trak": return parent == "moov"
    case "mdia": return parent == "trak"
    case "minf": return parent == "mdia"
    default: return parent == "minf"
    }
  }
  private mutating func entries(_ parent: Box, _ references: Bool, _ track: inout Track) throws -> Bool {
    guard parent.end - parent.start >= 8, try uint(parent.start) == 0 else { return false }
    let count = try uint(parent.start + 4)
    guard (1...16).contains(count), !(references ? track.references : track.descriptions) else { return false }
    var at = parent.start + 8
    for _ in 0..<count {
      guard let entry = try box(at, parent.end) else { return false }
      if references {
        guard entry.type == "url ", entry.end - entry.start == 4, try uint(entry.start) == 1 else { return false }
      } else {
        guard Self.codecs.contains(entry.type), entry.end - entry.start >= 8 else { return false }
        if entry.type != "mp4a" {
          guard entry.end - entry.start >= 78 else { return false }
          let dimensions = try uint(entry.start + 24)
          guard Self.validDimensions(Double(dimensions >> 16), Double(dimensions & 0xffff)) else { return false }
          video = true
        }
      }
      at = entry.end
    }
    if references { track.references = true } else { track.descriptions = true }
    return at == parent.end
  }
}
