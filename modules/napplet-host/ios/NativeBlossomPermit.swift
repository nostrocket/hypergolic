import Foundation
import CryptoKit

/// Private app credential shape/hash/scope checks. App Schnorr verification remains mandatory;
/// this parser alone grants no signing/dispatch authority and is not a Schnorr verifier.
struct NativeBlossomPermit: Sendable {
  let review: NativeUploadAuthority.Review
  let authorization: String
  let createdAt: Int64
  let expiration: Int64
  private init(_ review: NativeUploadAuthority.Review, _ token: String, _ createdAt: Int64, _ expiration: Int64) {
    self.review = review; authorization = "Nostr " + token; self.createdAt = createdAt; self.expiration = expiration
  }
  func validAt(_ now: Int64) -> Bool { createdAt < now && now < expiration }
  static func capture(_ review: NativeUploadAuthority.Review, token: String, now: Int64) -> NativeBlossomPermit? {
    guard !token.isEmpty, token.utf8.count <= 4096, token.utf8.allSatisfy({
      (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
    }), (1...9_007_199_254_740_991).contains(now),
      let decoded = Data(base64Encoded: token.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - token.count % 4) % 4)),
      base64url(decoded) == token, let json = String(data: decoded, encoding: .utf8),
      let server = URLComponents(string: review.destination)?.host else { return nil }
    let content = "Upload reviewed file to " + review.destination
    let tagsStart = "[[\"t\",\"upload\"],[\"x\",\"" + review.sha256 + "\"],[\"server\",\"" + server + "\"],[\"expiration\",\""
    let quote = NSRegularExpression.escapedPattern(for:)
    let expression = quote("{\"id\":\"") + "([0-9a-f]{64})" + quote("\",\"pubkey\":\"" + review.identity + "\",\"created_at\":") + "([0-9]{1,16})" +
      quote(",\"kind\":24242,\"tags\":" + tagsStart) + "([0-9]{1,16})" + quote("\"]],\"content\":\"" + content + "\",\"sig\":\"") + "([0-9a-f]{128})" + quote("\"}")
    guard let regex = try? NSRegularExpression(pattern: expression), let match = regex.firstMatch(in: json, range: NSRange(json.startIndex..., in: json)),
      match.range == NSRange(json.startIndex..., in: json) else { return nil }
    func field(_ index: Int) -> String { guard let range = Range(match.range(at: index), in: json) else { return "" }; return String(json[range]) }
    guard let created = Int64(field(2)), let expiration = Int64(field(3)), created >= 1, created < now,
      created <= 9_007_199_254_740_871, expiration == created + 120, expiration > now else { return nil }
    let tags = tagsStart + String(expiration) + "\"]]"
    let canonical = "[0,\"" + review.identity + "\"," + String(created) + ",24242," + tags + ",\"" + content + "\"]"
    let hash = SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    return hash == field(1) ? NativeBlossomPermit(review, token, created, expiration) : nil
  }
  private static func base64url(_ value: Data) -> String {
    value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}
