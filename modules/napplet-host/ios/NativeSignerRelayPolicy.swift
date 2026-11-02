import Foundation

/// Shared native lexical WSS policy; network owners additionally resolve and pin public addresses.
public enum NativeSignerRelayPolicy {
  public struct Endpoint: Sendable {
    public let url: String
    public let host: String
    public let port: UInt16
    public let target: String
  }
  public enum Failure: Error { case invalid }
  public static func endpoint(_ input: String) throws -> Endpoint {
    guard input.utf8.count <= 2048, input == input.trimmingCharacters(in: .whitespacesAndNewlines),
      !input.contains("\\"), !input.utf8.contains(where: { $0 <= 0x20 || $0 == 0x7f }),
      let original = URLComponents(string: input), original.scheme?.lowercased() == "wss",
      original.user == nil, original.password == nil, original.query == nil, original.fragment == nil,
      let host = original.host?.lowercased(), host.count <= 253, host.contains("."),
      !host.contains(":"), !host.hasSuffix("."), original.port == nil || (1...65535).contains(original.port!) else { throw Failure.invalid }
    let originalPath = original.percentEncodedPath.isEmpty ? "/" : original.percentEncodedPath
    guard originalPath.hasPrefix("/"), originalPath.utf8.allSatisfy({ (33...126).contains($0) }),
      originalPath.range(of: "%([01][0-9a-fA-F]|7[fF])", options: .regularExpression) == nil else { throw Failure.invalid }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    guard labels.allSatisfy({ !$0.isEmpty && $0.count <= 63 && $0.first != "-" && $0.last != "-" &&
      $0.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 } }),
      !host.utf8.allSatisfy({ (48...57).contains($0) || $0 == 46 }),
      !["localhost", "local", "localdomain", "internal", "home", "home.arpa", "lan", "test", "example", "invalid", "onion", "arpa"].contains(where: { host == $0 || host.hasSuffix(".\($0)") }),
      labels.last?.utf8.allSatisfy({ (48...57).contains($0) }) != true,
      let standardized = URL(string: input)?.standardized,
      let parts = URLComponents(url: standardized, resolvingAgainstBaseURL: false) else { throw Failure.invalid }
    let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
    guard path.hasPrefix("/"), path.utf8.allSatisfy({ (33...126).contains($0) }),
      path.range(of: "%([01][0-9a-fA-F]|7[fF])", options: .regularExpression) == nil else { throw Failure.invalid }
    let port = UInt16(original.port ?? 443)
    let normalized = "wss://" + host + (port == 443 ? "" : ":\(port)") + (path == "/" ? "" : path)
    guard normalized.utf8.count <= 2048 else { throw Failure.invalid }
    return Endpoint(url: normalized, host: host, port: port, target: path)
  }
  /// Safari owns browser TLS and redirects. The initial destination is strictly validated natively.
  public static func authenticationDestination(_ raw: String) throws -> URL {
    guard !raw.isEmpty, raw.utf8.count <= 2048, raw.utf8.allSatisfy({ (33...126).contains($0) }),
      let parts = URLComponents(string: raw), parts.scheme == "https", let url = parts.url else { throw Failure.invalid }
    _ = try PublishedPinnedHTTPS.Request(raw)
    // Apply the same strict DNS-label/local/literal exclusions as the signer relay policy.
    _ = try endpoint("wss://" + (parts.host ?? "") + (parts.port.map { ":\($0)" } ?? ""))
    return url
  }
  public static func validateAuthenticationResolution(_ url: URL) throws {
    let request = try PublishedPinnedHTTPS.Request(url.absoluteString); _ = try PublishedPinnedHTTPS.resolve(request.host)
  }
  public static func normalized(_ input: String) throws -> String { try endpoint(input).url }
}
