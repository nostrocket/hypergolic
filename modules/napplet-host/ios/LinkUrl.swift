import Foundation
import Darwin

/// Same conservative ASCII absolute URI profile as Android; no network preflight.
enum LinkUrl {
  /// Signed identity controls are displayed literally rather than changing review structure.
  static func displayIdentity(_ value: String) -> String {
    value.unicodeScalars.map {scalar in
      let c = scalar.value
      if c < 32 || (127...159).contains(c) || c == 0x061c || c == 0x200e || c == 0x200f ||
        (0x2028...0x202e).contains(c) || (0x2066...0x2069).contains(c) {return String(format: "\\u%04X", c)}
      return String(scalar)
    }.joined()
  }
  static func error(_ raw: String?) -> String? {
    guard let raw, !raw.isEmpty, raw.utf8.count <= 4096,
      raw.unicodeScalars.allSatisfy({$0.value >= 33 && $0.value <= 126 && $0.value != 92}) else {return "invalid-url"}
    guard let colon = raw.firstIndex(of: ":"), raw[..<colon].range(of: "^[A-Za-z][A-Za-z0-9+.-]*$", options: .regularExpression) != nil else {return "invalid-url"}
    guard raw[..<colon].lowercased() == "https" else {return "unsupported-scheme"}
    guard raw.range(of: "%([^0-9A-Fa-f]|$)|%[0-9A-Fa-f]([^0-9A-Fa-f]|$)", options: .regularExpression) == nil,
      raw.range(of: "^https://(?:[A-Za-z0-9.-]+|\\[[0-9A-Fa-f:.]+\\])(?::[0-9]{1,5})?(?:[/?#]|$)", options: [.regularExpression, .caseInsensitive]) != nil,
      let parts = URLComponents(string: raw), parts.host != nil,
      parts.user == nil, parts.password == nil, (parts.port == nil || (1...65535).contains(parts.port!)),
      let url = URL(string: raw), url.absoluteString == raw else {return "invalid-url"}
    let authority = raw.dropFirst(raw.distance(from: raw.startIndex, to: colon) + 3).prefix { !["/", "?", "#"].contains($0) }
    let host = authority.hasPrefix("[") ? String(authority.prefix(through: authority.firstIndex(of: "]")!)) : String(authority.split(separator: ":", omittingEmptySubsequences: false)[0])
    guard !host.isEmpty, host.utf8.count <= 253, !host.hasSuffix("."), !host.contains("%") else {return "invalid-url"}
    if host.hasPrefix("[") {
      var address = in6_addr()
      let valid = String(host.dropFirst().dropLast()).withCString {inet_pton(AF_INET6, $0, &address)}
      return valid == 1 ? nil : "invalid-url"
    }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    guard labels.allSatisfy({$0.range(of: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$", options: .regularExpression) != nil}) else {return "invalid-url"}
    if host.allSatisfy({$0.isNumber || $0 == "."}) {
      guard labels.count == 4, labels.allSatisfy({$0.count <= 3 && ($0.count == 1 || !$0.hasPrefix("0")) && Int($0).map({$0 <= 255}) == true}) else {return "invalid-url"}
    }
    return nil
  }
}
