import Foundation
import CoreFoundation

/// Keep the first exact native ACK; later close/invalid data cannot erase an observed acceptance.
final class OutboxAcknowledgement: @unchecked Sendable {
  struct Ack: Sendable { let accepted: Bool; let reason: String }
  private let eventId: String
  private let lock = NSLock()
  private var captured: Ack?
  var result: Ack? { lock.withLock { captured } }
  init(_ eventId: String) { self.eventId = eventId }
  func classify(_ text: String) throws -> PublishedRelayWebSocketQuery.TextKind {
    guard NativeOutboxPlan.boundedJSON(text),
      let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [Any] else { throw NativeOutboxPlan.Failure.invalid }
    guard value.first as? String == "OK", value.count > 1, value[1] as? String == eventId else { return .other }
    guard value.count == 4, let accepted = value[2] as? NSNumber, CFGetTypeID(accepted) == CFBooleanGetTypeID(),
      let reason = value[3] as? String, reason.utf8.count <= 4096 else { throw NativeOutboxPlan.Failure.invalid }
    lock.withLock { if captured == nil { captured = Ack(accepted: accepted.boolValue, reason: reason) } }
    return .eose
  }
}
