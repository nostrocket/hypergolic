import Foundation

/// Per-session correlation for the shell-owned MCP handshake. Access stays on the session queue.
enum NativeCvmInitialization {
  enum Failure: Error { case denied }
  case idle
  case prepared(id: String)
  case waiting(id: String, eventId: String)
  case replied
  case finished

  mutating func prepare(id: String) throws {
    guard case .idle = self else { throw Failure.denied }
    self = .prepared(id: id)
  }

  mutating func commit(eventId: String) throws {
    guard case let .prepared(id) = self else { throw Failure.denied }
    self = .waiting(id: id, eventId: eventId)
  }

  mutating func receive(_ message: String, references: [String]) {
    guard case let .waiting(id, eventId) = self, references.contains(eventId),
      let reply = try? JSONDecoder().decode(Reply.self, from: Data(message.utf8)), reply.id == id
    else { return }
    self = .replied
  }

  mutating func finish() throws {
    guard case .replied = self else { throw Failure.denied }
    self = .finished
  }

  // Decode only the handshake fields of a reply referencing our authenticated init event.
  // Unknown MCP fields (including arbitrary capability values) stay opaque.
  private struct Reply: Decodable {
    let id: String
    private enum Fields: String, CodingKey { case jsonrpc, id, method, error, result }
    private enum ResultFields: String, CodingKey { case protocolVersion, capabilities }

    init(from decoder: any Decoder) throws {
      let fields = try decoder.container(keyedBy: Fields.self)
      guard !fields.contains(.method), !fields.contains(.error),
        try fields.decode(String.self, forKey: .jsonrpc) == "2.0"
      else { throw Failure.denied }
      id = try fields.decode(String.self, forKey: .id)
      let result = try fields.nestedContainer(keyedBy: ResultFields.self, forKey: .result)
      guard try result.decode(String.self, forKey: .protocolVersion) == "2025-06-18" else {
        throw Failure.denied
      }
      _ = try result.nestedContainer(keyedBy: ResultFields.self, forKey: .capabilities)
    }
  }
}
