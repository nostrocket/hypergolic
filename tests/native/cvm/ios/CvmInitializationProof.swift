import Foundation

@main
enum CvmInitializationProof {
  static func mustDeny(_ label: String, _ action: () throws -> Void) throws {
    do {
      try action()
      fatalError("Expected denial: " + label)
    } catch NativeCvmInitialization.Failure.denied {}
  }

  static func main() throws {
    let id = "hypergolic:init:11111111-1111-4111-8111-111111111111"
    let eventId = String(repeating: "1", count: 64)
    let otherEvent = String(repeating: "2", count: 64)
    let result = #"{"protocolVersion":"2025-06-18","capabilities":{"tools":{"label":"\ud800"}}}"#
    let reply = #"{"jsonrpc":"2.0","id":"\#(id)","result":\#(result)}"#
    var handshake = NativeCvmInitialization.idle

    try mustDeny("commit before prepare") { try handshake.commit(eventId: eventId) }
    try mustDeny("initialized before initialize") { try handshake.finish() }
    try handshake.prepare(id: id)
    try mustDeny("duplicate prepare") { try handshake.prepare(id: id) }
    handshake.receive(reply, references: [eventId])
    try mustDeny("reply before commit") { try handshake.finish() }
    try handshake.commit(eventId: eventId)
    try mustDeny("duplicate commit") { try handshake.commit(eventId: otherEvent) }

    for references in [[], [otherEvent]] {
      handshake.receive(reply, references: references)
      try mustDeny("uncorrelated event reference") { try handshake.finish() }
    }
    for (field, replacement) in [
      (id, "another-request"),
      (#""jsonrpc":"2.0""#, #""jsonrpc":"1.0""#),
      (#""result":"#, #""method":"notifications/other","result":"#),
      (#""result":"#, #""error":null,"result":"#),
      ("2025-06-18", "2024-11-05"),
      (result, #"{"protocolVersion":"2025-06-18"}"#),
      (result, #"{"protocolVersion":"2025-06-18","capabilities":[]}"#)
    ] {
      handshake.receive(reply.replacingOccurrences(of: field, with: replacement), references: [eventId])
      try mustDeny("mismatched or malformed initialize result") { try handshake.finish() }
    }

    handshake.receive(reply, references: [otherEvent, eventId])
    try handshake.finish()
    handshake.receive(reply, references: [eventId])
    try mustDeny("repeated initialized") { try handshake.finish() }
    try mustDeny("restarted handshake") { try handshake.prepare(id: id) }
    print("CVM initialization correlation passed")
  }
}
