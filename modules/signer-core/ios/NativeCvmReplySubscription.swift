import Foundation

enum NativeCvmReplySubscription {
  // An encrypted outer event may be backdated by up to two days.
  static let maximumAge: UInt64 = 2 * 24 * 60 * 60

  static func request(id: String, recipient: String, now: UInt64) throws -> String {
    let since = max(now, maximumAge) - maximumAge
    let filter: [String: Any] = ["kinds": [1059, 21059], "#p": [recipient], "since": since, "limit": 0]
    let bytes = try JSONSerialization.data(withJSONObject: ["REQ", id, filter])
    return String(decoding: bytes, as: UTF8.self)
  }
}
