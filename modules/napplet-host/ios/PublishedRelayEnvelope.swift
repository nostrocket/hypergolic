import CoreFoundation
import Foundation

/// Structural classifier for one relay text envelope. Subscription ids are compared
/// exactly; no substring matching is used to detect EOSE.
enum PublishedRelayEnvelope {
  static func classify(_ text: String, subscriptionId: String) -> PublishedRelayWebSocketQuery.TextKind {
    guard text.utf8.count <= PublishedRelayWebSocketFrames.maxBytes,
          subscriptionId.utf8.count > 0, subscriptionId.utf8.count <= 64,
          let data = text.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data),
          let envelope = value as? [Any], let command = envelope.first as? String else { return .invalid }

    switch command {
    case "EVENT":
      guard envelope.count == 3, envelope[1] as? String == subscriptionId,
            let event = envelope[2] as? [String: Any], validEvent(event) else { return .invalid }
      return .event
    case "EOSE":
      guard envelope.count == 2, envelope[1] as? String == subscriptionId else { return .invalid }
      return .eose
    case "NOTICE":
      guard envelope.count == 2, let notice = envelope[1] as? String, notice.utf8.count <= 256 else { return .invalid }
      return .other
    case "AUTH":
      // Optional NIP-42 announcement. Existing frame/count budgets still apply;
      // no challenge is stored and no signer or client AUTH is invoked.
      guard envelope.count == 2, envelope[1] is String else { return .invalid }
      return .other
    case "CLOSED":
      // A well-formed CLOSED is a terminal relay error for this query; all other
      // shapes and subscription ids are invalid as well, so every CLOSED fails closed.
      return .invalid
    default:
      return .invalid
    }
  }

  private static func validEvent(_ event: [String: Any]) -> Bool {
    guard Set(event.keys) == Set(["id", "pubkey", "created_at", "kind", "tags", "content", "sig"]),
          let id = event["id"] as? String, isHex(id, bytes: 32),
          let pubkey = event["pubkey"] as? String, isHex(pubkey, bytes: 32),
          let signature = event["sig"] as? String, isHex(signature, bytes: 64),
          let createdAt = integer(event["created_at"]), createdAt >= 0,
          let kind = integer(event["kind"]), kind >= 0, kind <= Int64(Int32.max),
          let tags = event["tags"] as? [Any],
          tags.allSatisfy({ tag in (tag as? [Any])?.allSatisfy { $0 is String } == true }),
          event["content"] is String else { return false }
    return true
  }

  private static func integer(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let type = String(cString: number.objCType)
    guard !["f", "d"].contains(type) else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double >= Double(Int64.min), double < Double(Int64.max) else { return nil }
    return number.int64Value
  }

  private static func isHex(_ value: String, bytes: Int) -> Bool {
    value.utf8.count == bytes * 2 && value.utf8.allSatisfy {
      ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
    }
  }
}
