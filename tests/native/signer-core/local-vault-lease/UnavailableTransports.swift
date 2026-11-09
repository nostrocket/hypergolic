import Foundation

// Only unused network methods are replaced in the host proof. The production signer Pod is compiled separately.
final class NativeNip46Handoff: Sendable {}
final class NativeNip46DispatchState: Sendable { var possible: Bool { false } }
struct NativeNip46Client {
  typealias Exchange = @Sendable () async throws -> Void
  init(key: NativeVaultKey, peer: String, handoff: NativeNip46Handoff?, exchange: @escaping Exchange = {}) {}
  func sign(_ event: ExactSignerEvent, relays: [String], deadline: ContinuousClock.Instant,
    current: @Sendable () -> Bool, dispatch: @Sendable (@Sendable () -> Void) throws -> Void,
    state: NativeNip46DispatchState) async throws -> String {
    preconditionFailure("Vault lease proof must never invoke a transport signer")
  }
}
enum PublishedPinnedHTTPS {
  struct Request {
    let host: String
    init(_ raw: String) throws { preconditionFailure("Vault lease proof must never prepare HTTPS") }
  }
  static func resolve(_ host: String) throws { preconditionFailure("Vault lease proof must never resolve HTTPS") }
}
