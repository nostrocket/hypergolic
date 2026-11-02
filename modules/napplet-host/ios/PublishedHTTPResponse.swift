import Foundation

/// Strict HTTP/1.1 response framing for a pinned, TLS-protected Blossom connection.
/// The network owner must feed this parser in bounded chunks and enforce its own deadline.
struct PublishedHTTPResponse {
  static let maximumHeaderBytes = 16 * 1024
  static let maximumFramingBytes = 64 * 1024
  static let maximumBodyBytes = 2 * 1024 * 1024
  static let maximumUploadBodyBytes = 32 * 1024
  static let maximumResourceBodyBytes = 10 * 1024 * 1024

  enum Failure: Error { case invalidResponse, tooLarge, resourceStatus(Int), resourcePolicy, resourceRedirect(String), uploadStatus(Int), uploadPolicy, recoveryStatus(Int), recoveryRedirect(String) }

  let status: Int
  let headers: [String: String]
  let body: Data

  static func parse(_ wire: Data, maximumBodyBytes: Int = maximumBodyBytes, resourceProfile: Bool = false, uploadProfile: Bool = false, recoveryProfile: Bool = false) throws -> PublishedHTTPResponse {
    guard !(resourceProfile && (uploadProfile || recoveryProfile)), !(uploadProfile && recoveryProfile), !uploadProfile || maximumBodyBytes <= Self.maximumUploadBodyBytes,
          (1...((resourceProfile || recoveryProfile) ? Self.maximumResourceBodyBytes : Self.maximumBodyBytes)).contains(maximumBodyBytes),
          wire.count <= maximumBodyBytes + maximumHeaderBytes + maximumFramingBytes else { throw Failure.tooLarge }
    let separator = Data([13, 10, 13, 10])
    guard let boundary = wire.range(of: separator), boundary.lowerBound <= maximumHeaderBytes else { throw Failure.invalidResponse }
    let rawHead = wire.prefix(upTo: boundary.lowerBound)
    guard rawHead.allSatisfy({ $0 >= 32 && $0 <= 126 || $0 == 13 || $0 == 10 }),
          let head = String(data: rawHead, encoding: .ascii) else { throw Failure.invalidResponse }
    let lines = head.components(separatedBy: "\r\n")
    guard let statusLine = lines.first, statusLine.hasPrefix("HTTP/1.1 "),
          statusLine.count >= 12, let status = Int(statusLine.dropFirst(9).prefix(3)),
          (statusLine.count == 12 || statusLine[statusLine.index(statusLine.startIndex, offsetBy: 12)] == " "),
          statusLine.dropFirst(12).allSatisfy({ $0 == " " || $0.isASCII && !$0.isNewline }),
          lines.dropFirst().allSatisfy({ !$0.isEmpty && !$0.hasPrefix(" ") && !$0.hasPrefix("\t") })
    else { throw Failure.invalidResponse }
    let singular = Set(["content-length", "transfer-encoding", "content-encoding", "location", "connection"])
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { throw Failure.invalidResponse }
      let name = String(line[..<colon]).lowercased()
      let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
      guard !name.isEmpty, name.utf8.allSatisfy({ byte in
        (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte == 45
      }), (!headers.keys.contains(name) || (resourceProfile || uploadProfile || recoveryProfile) && !singular.contains(name)), !value.contains("\r"), !value.contains("\n")
      else { throw Failure.invalidResponse }
      // Resource headers never enter the SDK; repeated informational values have no authority.
      if headers[name] == nil { headers[name] = value }
    }
    if resourceProfile && [301,302,303,307,308].contains(status) {
      guard let location = headers["location"], !location.isEmpty, location.utf8.count <= 8192 else { throw Failure.resourcePolicy }
      throw Failure.resourceRedirect(location)
    }
    if recoveryProfile && [301,302,303,307,308].contains(status) {
      guard let location = headers["location"], !location.isEmpty, location.utf8.count <= 8192 else { throw Failure.uploadPolicy }
      throw Failure.recoveryRedirect(location)
    }
    if (uploadProfile || recoveryProfile) && (300...399).contains(status) { throw Failure.uploadPolicy }
    guard uploadProfile || recoveryProfile || status == 200 else {
      if resourceProfile { throw Failure.resourceStatus(status) }
      throw Failure.invalidResponse
    }
    guard !headers.keys.contains("content-encoding") || recoveryProfile && headers["content-encoding"]?.lowercased() == "identity",
          !headers.keys.contains("location"),
          !headers.keys.contains("connection") || headers["connection"]?.lowercased() == "close" || headers["connection"]?.lowercased() == "keep-alive"
    else { throw resourceProfile ? Failure.resourcePolicy : Failure.invalidResponse }
    func complete(_ body: Data) throws -> PublishedHTTPResponse {
      // Classify rejection/absence only after all bounded framing and bytes are valid.
      if uploadProfile && status != 200 && status != 201 { throw Failure.uploadStatus(status) }
      if recoveryProfile && status != 200 && status != 404 { throw Failure.recoveryStatus(status) }
      return PublishedHTTPResponse(status: status, headers: headers, body: body)
    }
    let payload = wire.suffix(from: boundary.upperBound)
    let hasLength = headers["content-length"] != nil
    let chunked = headers["transfer-encoding"]?.lowercased() == "chunked"
    guard hasLength != chunked, headers["transfer-encoding"] == nil || chunked else { throw Failure.invalidResponse }
    if hasLength {
      let value = headers["content-length"]!
      guard !value.isEmpty, value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
            let length = Int(value), length <= maximumBodyBytes, payload.count == length
      else { throw Failure.invalidResponse }
      return try complete(Data(payload))
    }
    let body = try decodeChunked(Data(payload), limit: maximumBodyBytes)
    return try complete(body)
  }

  private static func decodeChunked(_ payload: Data, limit: Int) throws -> Data {
    var cursor = payload.startIndex
    var body = Data()
    var overhead = 0
    let crlf = Data([13, 10])
    while true {
      guard let end = payload.range(of: crlf, in: cursor..<payload.endIndex)?.lowerBound,
            end - cursor <= 8 else { throw Failure.invalidResponse }
      let lengthText = payload[cursor..<end]
      guard !lengthText.isEmpty, lengthText.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 70) || ($0 >= 97 && $0 <= 102) }),
            let length = Int(String(decoding: lengthText, as: UTF8.self), radix: 16), length <= limit - body.count
      else { throw Failure.invalidResponse }
      overhead += end - cursor + 2
      cursor = end + 2
      guard overhead <= maximumFramingBytes else { throw Failure.tooLarge }
      if length == 0 {
        guard payload.distance(from: cursor, to: payload.endIndex) == 2,
              payload[cursor] == 13, payload[cursor + 1] == 10 else { throw Failure.invalidResponse }
        return body
      }
      guard length <= payload.distance(from: cursor, to: payload.endIndex) - 2,
            payload[cursor + length] == 13, payload[cursor + length + 1] == 10 else { throw Failure.invalidResponse }
      body.append(contentsOf: payload[cursor..<(cursor + length)])
      cursor += length + 2
      overhead += 2
      guard overhead <= maximumFramingBytes else { throw Failure.tooLarge }
    }
  }
}

/// Stores at most one bounded response while Network.framework delivers small reads.
final class PublishedHTTPResponseAccumulator {
  private var wire = Data()
  private let maximumBodyBytes: Int
  private let resourceProfile: Bool
  private let uploadProfile: Bool
  private let recoveryProfile: Bool

  init(maximumBodyBytes: Int, resourceProfile: Bool = false, uploadProfile: Bool = false, recoveryProfile: Bool = false) throws {
    guard !(resourceProfile && (uploadProfile || recoveryProfile)), !(uploadProfile && recoveryProfile), !uploadProfile || maximumBodyBytes <= PublishedHTTPResponse.maximumUploadBodyBytes,
          (1...((resourceProfile || recoveryProfile) ? PublishedHTTPResponse.maximumResourceBodyBytes : PublishedHTTPResponse.maximumBodyBytes)).contains(maximumBodyBytes) else {
      throw PublishedHTTPResponse.Failure.tooLarge
    }
    self.maximumBodyBytes = maximumBodyBytes
    self.resourceProfile = resourceProfile
    self.uploadProfile = uploadProfile
    self.recoveryProfile = recoveryProfile
  }

  func append(_ chunk: Data) throws {
    let ceiling = maximumBodyBytes + PublishedHTTPResponse.maximumHeaderBytes + PublishedHTTPResponse.maximumFramingBytes
    guard chunk.count <= 8192, chunk.count <= ceiling - wire.count else { throw PublishedHTTPResponse.Failure.tooLarge }
    wire.append(chunk)
    let separator = Data([13, 10, 13, 10])
    if let boundary = wire.range(of: separator) {
      guard boundary.lowerBound <= PublishedHTTPResponse.maximumHeaderBytes else { throw PublishedHTTPResponse.Failure.tooLarge }
      if wire.count >= 12, let status = Int(String(decoding: wire[9..<12], as: UTF8.self)),
        (resourceProfile && status != 200 || recoveryProfile && [301,302,303,307,308].contains(status)) {
        _ = try PublishedHTTPResponse.parse(wire, maximumBodyBytes: maximumBodyBytes, resourceProfile: resourceProfile, uploadProfile: uploadProfile, recoveryProfile: recoveryProfile)
      }
    } else if wire.count > PublishedHTTPResponse.maximumHeaderBytes + separator.count {
      throw PublishedHTTPResponse.Failure.tooLarge
    }
  }

  func finish() throws -> PublishedHTTPResponse {
    defer { wire.removeAll(keepingCapacity: false) }
    return try PublishedHTTPResponse.parse(wire, maximumBodyBytes: maximumBodyBytes, resourceProfile: resourceProfile, uploadProfile: uploadProfile, recoveryProfile: recoveryProfile)
  }
}
