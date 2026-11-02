import Foundation

// Only the Client-used interface is doubled. No sockets or production budget policy.
// Default exchange must fail: every test supplies its explicit encrypted exchange.
enum NativeSignerRelayTransport {
  enum Failure: Error { case unavailable, invalidResponse, expired, cancelled, uncertain }
  final class Budget: Sendable {
    init(maximumOpens: Int = 9) { }
    func isValid(deadline: ContinuousClock.Instant) -> Bool { ContinuousClock.now < deadline }
  }
  struct Control: Sendable {
    let current: @Sendable () -> Bool
    let budget: Budget
    let dispatch: @Sendable (@Sendable () -> Void) throws -> Void
  }
  final class Operation: Sendable { func cancel() { } }
  static func exchange(_ relay: String, subscription: String, event: String, deadline: ContinuousClock.Instant,
    control: Control, validate: @escaping @Sendable (String) throws -> Bool,
    completion: @escaping @Sendable (Result<String, Error>) -> Void) throws -> Operation {
    throw Failure.unavailable
  }
}

// DNS/TLS and HTTPS policy are outside this host regression. The actual owning
// NativeSignerRelayPolicy still validates the challenge host through endpoint().
enum PublishedPinnedHTTPS {
  struct Request {
    let host: String
    init(_ raw: String) throws {
      guard let url = URL(string: raw), url.scheme == "https", let host = url.host else {
        throw NativeSignerRelayPolicy.Failure.invalid
      }
      self.host = host
    }
  }
  static func resolve(_ host: String) throws -> [String] { throw NativeSignerRelayPolicy.Failure.invalid }
}
