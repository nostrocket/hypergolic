import Foundation
import CoreFoundation

/// Native interpretation of carrier headers and exact provider receipts; never a generic fetch API.
enum UploadWire {
  enum Invalid: Error { case value }
  static func fields(_ value: [String: Any], _ required: Set<String>, _ optional: Set<String> = []) throws {
    let keys = Set(value.keys)
    guard required.isSubset(of: keys), keys.subtracting(required).subtracting(optional).isEmpty else { throw Invalid.value }
  }
  static func text(_ value: Any?, _ limit: Int, empty: Bool = false) throws -> String {
    guard let value = value as? String, (empty || !value.isEmpty), value.utf8.count <= limit else { throw Invalid.value }; return value
  }
  static func integer(_ value: Any?, _ maximum: Int64) throws -> Int64 {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
      value.doubleValue >= 0, value.doubleValue <= Double(maximum), value.doubleValue.rounded(.towardZero) == value.doubleValue else { throw Invalid.value }
    return value.int64Value
  }
  static func json(_ value: [String: Any]) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self) }
  static func object(_ raw: String, limit: Int = 32 * 1024, maximumDepth: Int = 12) throws -> [String: Any] {
    guard boundedJSON(raw, limit: limit, maximumDepth: maximumDepth), let value = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { throw Invalid.value }; return value
  }
  static func boundedJSON(_ input: String, limit: Int, maximumDepth: Int = 12) -> Bool {
    guard maximumDepth > 0, maximumDepth <= 40, input.utf8.count <= limit else { return false }
    var depth = 0, quoted = false, escaped = false
    for value in input.utf8 {
      if quoted {
        if escaped { escaped = false }
        else if value == 92 { escaped = true }
        else if value == 34 { quoted = false }
      } else if value == 34 { quoted = true }
      else if value == 91 || value == 123 { depth += 1; if depth > maximumDepth { return false } }
      else if value == 93 || value == 125 { depth -= 1; if depth < 0 { return false } }
    }
    return depth == 0 && !quoted
  }
  static func header(_ value: [String: Any]) throws -> String {
    try fields(value, [], ["rail", "mimeType", "filename", "caption", "noTransform", "metadata"])
    if let rail = value["rail"] { guard rail as? String == "blossom" else { throw Invalid.value } }
    if let mime = value["mimeType"] {
      guard try text(mime, 128).range(of: "^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$", options: .regularExpression) != nil else { throw Invalid.value }
    }
    if let filename = value["filename"] { _ = try text(filename, 256, empty: true) }
    if let caption = value["caption"] { _ = try text(caption, 4096, empty: true) }
    if let flag = value["noTransform"] { guard let flag = flag as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { throw Invalid.value } }
    if let metadata = value["metadata"] { guard let metadata = metadata as? [String: Any] else { throw Invalid.value }; try validateMetadata(metadata) }
    let captured = try json(value); guard captured.utf8.count <= 32 * 1024 else { throw Invalid.value }; return captured
  }
  private static func validateMetadata(_ value: [String: Any]) throws {
    var nodes = 0
    func visit(_ value: Any, _ depth: Int) throws {
      nodes += 1; guard nodes <= 256, depth <= 8 else { throw Invalid.value }
      if value is NSNull { return }
      if let value = value as? String { _ = try text(value, 16 * 1024, empty: true); return }
      if let value = value as? NSNumber { guard value.doubleValue.isFinite else { throw Invalid.value }; return }
      if let value = value as? [Any] { guard value.count <= 256 else { throw Invalid.value }; for item in value { try visit(item, depth + 1) }; return }
      if let value = value as? [String: Any] { for (key, item) in value { _ = try text(key, 256, empty: true); try visit(item, depth + 1) }; return }
      throw Invalid.value
    }
    try visit(value, 0); guard try json(value).utf8.count <= 16 * 1024 else { throw Invalid.value }
  }
  static func chunk(_ value: Any?) throws -> Data {
    let raw = try text(value, ((NativeUploadAuthority.chunkBytes + 2) / 3) * 4)
    guard let bytes = Data(base64Encoded: raw), (1...NativeUploadAuthority.chunkBytes).contains(bytes.count), bytes.base64EncodedString() == raw else { throw Invalid.value }; return bytes
  }
  static func review(_ value: NativeUploadAuthority.Review) -> [String: Any] {
    ["purpose": "blossom-upload", "identity": value.identity, "destination": value.destination, "sha256": value.sha256,
      "size": value.size, "mimeType": value.mimeType, "metadataPolicy": value.metadataPolicy]
  }
  static func status(_ id: String, _ state: String, error: String? = nil) -> [String: Any] {
    var value: [String: Any] = ["ok": state != "failed" && state != "cancelled", "uploadId": id, "status": state, "rail": "blossom"]
    if let error { value["error"] = error }; return value
  }
  static let errors: Set<String> = ["invalid request", "unsupported rail", "policy denied", "no server configured", "file too large",
    "unsupported media type", "user cancelled", "server rejected", "upload failed", "quota exceeded", "outcome unknown"]
  static func terminal(_ raw: String, id: String) throws -> [String: Any] {
    let value = try object(raw)
    try fields(value, ["ok", "uploadId", "status", "rail"], ["url", "sha256", "size", "mimeType", "error", "bytesSent", "bytesTotal"])
    guard value["uploadId"] as? String == id, value["rail"] as? String == "blossom", let state = value["status"] as? String,
      ["complete", "failed", "cancelled"].contains(state), let ok = value["ok"] as? NSNumber,
      CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue == (state == "complete") else { throw Invalid.value }
    if state != "complete" { guard let error = value["error"] as? String, errors.contains(error), value["url"] == nil else { throw Invalid.value } }
    return state == "complete" ? value : status(id, state, error: value["error"] as? String)
  }
  static func receipt(_ bytes: Data, review: NativeUploadAuthority.Review, id: String) throws -> (descriptor: [String: Any], result: [String: Any]) {
    guard bytes.count <= 32 * 1024, let raw = String(data: bytes, encoding: .utf8) else { throw Invalid.value }
    let descriptor = try object(raw)
    guard descriptor.count <= 32 else { throw Invalid.value }; try validateMetadata(descriptor)
    guard descriptor["sha256"] as? String == review.sha256, try integer(descriptor["size"], Int64(NativeUploadAuthority.maxBytes)) == review.size,
      review.acceptsDescriptorType(descriptor["type"] as? String) else { throw Invalid.value }
    _ = try integer(descriptor["uploaded"], 9_007_199_254_740_991)
    let url = try text(descriptor["url"], 2048), request = try PublishedPinnedHTTPS.Request(url)
    guard request.target.range(of: "^/" + review.sha256 + "\\.[A-Za-z0-9]{1,16}$", options: .regularExpression) != nil else { throw Invalid.value }
    var result = status(id, "complete"); result["url"] = url; result["sha256"] = review.sha256; result["size"] = review.size; result["mimeType"] = review.mimeType
    return (descriptor, result)
  }
  static func sameCompletion(_ value: [String: Any], _ captured: [String: Any]) -> Bool {
    guard (try? fields(value, ["ok", "uploadId", "status", "rail", "url", "sha256", "size", "mimeType"])) != nil else { return false }
    return NSDictionary(dictionary: value).isEqual(to: captured)
  }
}
