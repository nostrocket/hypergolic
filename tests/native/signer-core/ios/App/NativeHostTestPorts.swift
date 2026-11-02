import Foundation

// Unused external services needed to compile the exact owning approval registry on Simulator.
// Tests instantiate isolated registries; no request reaches these ports. Every access fails closed.
enum RoutingTransport {
  struct Stub: Sendable { func foreground(_ value: Bool) {}; func revoke(_ generation: String) {} }
  static let shared = Stub()
}
enum LinkTransport { static func foreground(_ value: Bool) {} }
enum UploadTransport { static func foreground(_ value: Bool) {} }
enum IdentityListAccess {
  struct Ticket: Sendable {}
  struct Stub: Sendable {
    func captureJSON(_ snapshot: String) throws -> Ticket? { throw StoreFailure.unavailable }
    func permits(_ ticket: Ticket?) -> Bool { false }
  }
  static let shared = Stub()
}
enum ResourceHTTPSBridgeOwner {
  struct Stub: Sendable { func revoke(_ generation: String) {} }
  static let shared = Stub()
}
enum RelaySubscriptionTransport {
  struct Stub: Sendable { func revoke(_ generation: String) {} }
  static let shared = Stub()
}
