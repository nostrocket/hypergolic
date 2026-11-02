import Foundation
import CryptoKit

/// Exact NIP-01 input. The parser rejects duplicate keys, ambiguous numbers and broken Unicode.
struct ExactSignerEvent: Equatable, Sendable {
  static let maximumBytes = 2 * 1024 * 1024
  let pubkey: String
  let createdAt: UInt64
  let kind: UInt64
  let tags: [[String]]
  let content: String

  init(json: String, expectedPubkey: String, maximumBytes: Int = Self.maximumBytes) throws {
    var parser = SignerJSONParser(json, maximumBytes: maximumBytes + 256)
    guard case .object(let object) = try parser.parse(),
      Set(object.keys) == Set(["pubkey", "created_at", "kind", "tags", "content"]),
      case .string(let pubkey) = object["pubkey"], pubkey == expectedPubkey,
      case .integer(let createdAt) = object["created_at"],
      case .integer(let kind) = object["kind"], kind <= 65_535,
      case .string(let content) = object["content"],
      case .array(let rawTags) = object["tags"], rawTags.count <= Self.maximumBytes else { throw SignerFailure.invalidInput }
    let tags = try rawTags.map { tag -> [String] in
      guard case .array(let parts) = tag, !parts.isEmpty, parts.count <= Self.maximumBytes else { throw SignerFailure.invalidInput }
      return try parts.map { part in
        guard case .string(let string) = part else { throw SignerFailure.invalidInput }
        return string
      }
    }
    self.pubkey = pubkey; self.createdAt = createdAt; self.kind = kind; self.tags = tags; self.content = content
    guard canonical.utf8.count <= maximumBytes else { throw SignerFailure.invalidInput }
  }

  static func == (lhs: Self, rhs: Self) -> Bool { lhs.canonical.utf8.elementsEqual(rhs.canonical.utf8) }

  var unsignedJSON: String { "{\"pubkey\":\(Self.quote(pubkey)),\"created_at\":\(createdAt),\"kind\":\(kind),\"tags\":\(tagsJSON),\"content\":\(Self.quote(content))}" }
  private var tagsJSON: String { "[" + tags.map { "[" + $0.map(Self.quote).joined(separator: ",") + "]" }.joined(separator: ",") + "]" }
  var canonical: String { "[0,\(Self.quote(pubkey)),\(createdAt),\(kind),\(tagsJSON),\(Self.quote(content))]" }
  var digest: [UInt8] { Array(SHA256.hash(data: Data(canonical.utf8))) }
  func signedJSON(signature: [UInt8]) -> String {
    "{\"pubkey\":\(Self.quote(pubkey)),\"created_at\":\(createdAt),\"kind\":\(kind),\"tags\":\(tagsJSON),\"content\":\(Self.quote(content)),\"id\":\(Self.quote(digest.hex)),\"sig\":\(Self.quote(signature.hex))}"
  }
  static func quote(_ value: String) -> String {
    var result = "\""
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 34: result += "\\\""
      case 92: result += "\\\\"
      case 8: result += "\\b"
      case 9: result += "\\t"
      case 10: result += "\\n"
      case 12: result += "\\f"
      case 13: result += "\\r"
      case 0..<32: result += String(format: "\\u%04x", scalar.value)
      default: result.unicodeScalars.append(scalar)
      }
    }
    return result + "\""
  }
}

extension Array where Element == UInt8 {
  var hex: String { map { String(format: "%02x", $0) }.joined() }
}

indirect enum SignerJSONValue: Sendable {
  case object([String: SignerJSONValue]), array([SignerJSONValue]), string(String), integer(UInt64), null, boolean(Bool)
}

struct SignerJSONParser {
  let bytes: [UInt8]
  var index = 0
  let maximumBytes: Int
  init(_ json: String, maximumBytes: Int = ExactSignerEvent.maximumBytes + 256) { bytes = Array(json.utf8); self.maximumBytes = maximumBytes }
  mutating func parse() throws -> SignerJSONValue {
    guard !bytes.isEmpty, bytes.count <= maximumBytes else { throw SignerFailure.invalidInput }
    let value = try value(depth: 0)
    whitespace()
    guard index == bytes.count else { throw SignerFailure.invalidInput }
    return value
  }
  mutating func whitespace() { while index < bytes.count, [9, 10, 13, 32].contains(bytes[index]) { index += 1 } }
  mutating func consume(_ byte: UInt8) -> Bool {
    whitespace(); guard index < bytes.count, bytes[index] == byte else { return false }; index += 1; return true
  }
  mutating func value(depth: Int) throws -> SignerJSONValue {
    whitespace()
    guard depth <= 8, index < bytes.count else { throw SignerFailure.invalidInput }
    switch bytes[index] {
    case 34: return .string(try string())
    case 123:
      index += 1; var fields: [String: SignerJSONValue] = [:]
      if consume(125) { return .object(fields) }
      repeat {
        let key = try string()
        guard fields[key] == nil, fields.count < 8, consume(58) else { throw SignerFailure.invalidInput }
        fields[key] = try value(depth: depth + 1)
      } while consume(44)
      guard consume(125) else { throw SignerFailure.invalidInput }; return .object(fields)
    case 91:
      index += 1; var values: [SignerJSONValue] = []
      if consume(93) { return .array(values) }
      repeat {
        guard values.count < ExactSignerEvent.maximumBytes else { throw SignerFailure.invalidInput }
        values.append(try value(depth: depth + 1))
      } while consume(44)
      guard consume(93) else { throw SignerFailure.invalidInput }; return .array(values)
    case 110:
      guard index + 4 <= bytes.count, Array(bytes[index..<index+4]) == Array("null".utf8) else { throw SignerFailure.invalidInput }; index += 4; return .null
    case 116:
      guard index + 4 <= bytes.count, Array(bytes[index..<index+4]) == Array("true".utf8) else { throw SignerFailure.invalidInput }; index += 4; return .boolean(true)
    case 102:
      guard index + 5 <= bytes.count, Array(bytes[index..<index+5]) == Array("false".utf8) else { throw SignerFailure.invalidInput }; index += 5; return .boolean(false)
    case 48...57:
      let start = index
      while index < bytes.count, (48...57).contains(bytes[index]) { index += 1 }
      guard index - start == 1 || bytes[start] != 48,
        let number = UInt64(String(decoding: bytes[start..<index], as: UTF8.self)), number <= 9_007_199_254_740_991 else { throw SignerFailure.invalidInput }
      return .integer(number)
    default: throw SignerFailure.invalidInput
    }
  }
  mutating func hexUnit() throws -> UInt16 {
    guard index + 4 <= bytes.count else { throw SignerFailure.invalidInput }
    let text = String(decoding: bytes[index..<index+4], as: UTF8.self)
    guard text.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }),
      let unit = UInt16(text, radix: 16) else { throw SignerFailure.invalidInput }
    index += 4; return unit
  }
  mutating func string() throws -> String {
    whitespace(); let start = index
    guard consume(34) else { throw SignerFailure.invalidInput }
    while index < bytes.count {
      let byte = bytes[index]; index += 1
      if byte == 34 {
        guard let result = try JSONSerialization.jsonObject(with: Data(bytes[start..<index]), options: .fragmentsAllowed) as? String else { throw SignerFailure.invalidInput }
        return result
      }
      guard byte >= 32 else { throw SignerFailure.invalidInput }
      if byte == 92 {
        guard index < bytes.count else { throw SignerFailure.invalidInput }
        let escape = bytes[index]; index += 1
        if escape == 117 {
          let unit = try hexUnit()
          if (0xD800...0xDBFF).contains(unit) {
            guard index + 2 <= bytes.count, bytes[index] == 92, bytes[index+1] == 117 else { throw SignerFailure.invalidInput }
            index += 2
            guard (0xDC00...0xDFFF).contains(try hexUnit()) else { throw SignerFailure.invalidInput }
          } else if (0xDC00...0xDFFF).contains(unit) { throw SignerFailure.invalidInput }
        } else if ![34, 92, 47, 98, 102, 110, 114, 116].contains(escape) { throw SignerFailure.invalidInput }
      }
    }
    throw SignerFailure.invalidInput
  }
}
