import Foundation

/// Independent incremental live framing. Keeps only bounded head/line state, never an entire response body.
final class LiveMP3Response {
  enum Failure: Error { case framing, tooLarge, unsupported }
  private enum State { case head, chunkLine, chunk(Int), chunkEnd(Int), trailers, fixed(Int), untilEOF, done }
  private var state: State = .head
  private var line = Data(), head = Data()
  private var delimiter = 0, trailerBytes = 0, trailerLines = 0
  private var trailerNames = Set<String>()
  private let budget: LiveMP3Budget
  private let active: () throws -> Void
  private let output: (Data) throws -> Void
  init(budget: LiveMP3Budget, active: @escaping () throws -> Void, output: @escaping (Data) throws -> Void) {
    self.budget = budget; self.active = active; self.output = output
  }
  func append(_ chunk: Data) throws {
    guard !chunk.isEmpty && chunk.count <= 8192 else { throw Failure.tooLarge }
    try active(); try budget.charge(chunk.count)
    let bytes = [UInt8](chunk); var offset = 0
    while offset < bytes.count {
      try active(); try budget.check()
      switch state {
      case .head: try headerByte(bytes[offset]); offset += 1
      case .chunkLine, .trailers: try lineByte(bytes[offset]); offset += 1
      case .chunk(let left):
        let count = min(left, bytes.count - offset)
        try output(Data(bytes[offset..<(offset + count)])); offset += count
        state = count == left ? .chunkEnd(0) : .chunk(left - count)
      case .chunkEnd(let index):
        guard bytes[offset] == (index == 0 ? 13 : 10) else { throw Failure.framing }
        state = index == 0 ? .chunkEnd(1) : .chunkLine; offset += 1
      case .fixed(let left):
        let count = min(left, bytes.count - offset)
        try output(Data(bytes[offset..<(offset + count)])); offset += count
        state = count == left ? .done : .fixed(left - count)
      case .untilEOF: try output(Data(bytes[offset...])); offset = bytes.count
      case .done: throw Failure.framing
      }
    }
  }
  private func headerByte(_ byte: UInt8) throws {
    guard head.count < 32 * 1024, byte == 13 || byte == 10 || byte == 9 || (32...126).contains(byte) else { throw Failure.tooLarge }
    head.append(byte)
    let wanted: UInt8 = delimiter == 0 || delimiter == 2 ? 13 : 10
    delimiter = byte == wanted ? delimiter + 1 : byte == 13 ? 1 : 0
    if delimiter == 4 { try parseHead(); head.removeAll(keepingCapacity: false); delimiter = 0 }
  }
  private func parseHead() throws {
    guard let text = String(data: head.dropLast(4), encoding: .ascii) else { throw Failure.framing }
    let lines = text.components(separatedBy: "\r\n")
    guard let first = lines.first, first.range(of: "^HTTP/1\\.[01] [0-9]{3}( [ -~]*)?$", options: .regularExpression) != nil,
      first.utf8.count <= 128, lines.count <= 129,
      let status = Int(first.dropFirst(9).prefix(3)) else { throw Failure.framing }
    var fields: [String: String] = [:]
    for line in lines.dropFirst() {
      let (key, value) = try Self.field(line)
      guard fields.updateValue(value, forKey: key) == nil else { throw Failure.framing }
    }
    if [301,302,303,307,308].contains(status) {
      guard let location = fields["location"], !location.isEmpty, location.utf8.count <= 8192 else { throw Failure.framing }
      throw PublishedHTTPResponse.Failure.resourceRedirect(location)
    }
    guard status == 200, fields["location"] == nil, fields["content-range"] == nil,
      (fields["content-encoding"] ?? "identity").lowercased() == "identity", (fields["icy-metaint"] ?? "0") == "0",
      fields["content-type"]?.split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespaces).lowercased() == "audio/mpeg",
      fields["content-length"] == nil || fields["transfer-encoding"] == nil else { throw Failure.unsupported }
    if let transfer = fields["transfer-encoding"] {
      guard transfer.lowercased() == "chunked" else { throw Failure.unsupported }; state = .chunkLine
    } else if let length = fields["content-length"] {
      guard length.range(of: "^[0-9]{1,10}$", options: .regularExpression) != nil,
        let count = Int(length), count <= LiveMP3Budget.maximumBytes else { throw Failure.tooLarge }
      state = count == 0 ? .done : .fixed(count)
    } else { state = .untilEOF }
  }
  private static func field(_ line: String) throws -> (String, String) {
    guard line.utf8.count <= 8192, let colon = line.firstIndex(of: ":") else { throw Failure.framing }
    let name = String(line[..<colon])
    guard name.range(of: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", options: .regularExpression) != nil,
      line.utf8.allSatisfy({ $0 == 9 || (32...126).contains($0) }) else { throw Failure.framing }
    return (name.lowercased(), line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
  }
  private func lineByte(_ byte: UInt8) throws {
    let maximum = if case .trailers = state { 8192 } else { 128 }
    guard line.count < maximum + 2, byte == 13 || byte == 10 || byte == 9 || (32...126).contains(byte) else { throw Failure.tooLarge }
    line.append(byte)
    guard line.count >= 2, line.suffix(2) == Data([13,10]) else { return }
    guard let text = String(data: line.dropLast(2), encoding: .ascii), !text.contains("\r"), !text.contains("\n") else { throw Failure.framing }
    line.removeAll(keepingCapacity: true)
    if case .trailers = state {
      trailerBytes += text.utf8.count + 2
      guard trailerBytes <= 8192, trailerLines <= 32 else { throw Failure.tooLarge }
      if text.isEmpty { state = .done; return }
      trailerLines += 1; let (key, _) = try Self.field(text)
      guard !["content-length","content-type","content-encoding","transfer-encoding","location"].contains(key),
        !key.hasPrefix("icy-"), trailerNames.insert(key).inserted else { throw Failure.framing }
    } else {
      // This initial selected profile explicitly rejects chunk extensions.
      guard text.range(of: "^[0-9a-fA-F]{1,8}$", options: .regularExpression) != nil,
        let size = Int(text, radix: 16), size <= LiveMP3Budget.maximumBytes else { throw Failure.framing }
      state = size == 0 ? .trailers : .chunk(size)
    }
  }
  func finish() throws {
    try active(); try budget.check()
    switch state { case .done: return; case .untilEOF: state = .done; default: throw Failure.framing }
  }
}
