import Foundation

/// A native-only immutable source. Existing JS flags describe transport stages, never user consent.
public final class NativeSigningSourceCapture: @unchecked Sendable {
  public let identity: String
  public let requester: String
  public let destinations: [String]
  public let eventJSON: String?
  public let uploadHash: String?
  public let uploadSize: Int?
  public let uploadType: String?
  private let live: @Sendable () -> Bool
  private let claim: @Sendable () -> Bool
  private let cancelOperation: @Sendable () -> Void
  private let pauseOperation: @Sendable (Bool) -> Bool
  init(identity: String, requester: String, destinations: [String], eventJSON: String?, uploadHash: String? = nil,
    uploadSize: Int? = nil, uploadType: String? = nil, live: @escaping @Sendable () -> Bool,
    claim: @escaping @Sendable () -> Bool, cancel: @escaping @Sendable () -> Void, pause: @escaping @Sendable (Bool) -> Bool) {
    self.identity = identity; self.requester = requester; self.destinations = destinations; self.eventJSON = eventJSON
    self.uploadHash = uploadHash; self.uploadSize = uploadSize; self.uploadType = uploadType
    self.live = live; self.claim = claim; cancelOperation = cancel; pauseOperation = pause
  }
  public func isLive() -> Bool { live() }
  /// The signer invokes this only after its own native button gesture.
  public func consumeForNativeSigning() -> Bool { claim() }
  public func cancel() { cancelOperation() }
  public func pauseExecution(_ paused: Bool) -> Bool { pauseOperation(paused) }
}

/// No Expo function exposes this facade. The signer borrows native host state by its original token.
public enum NativeSigningSourceFacade {
  private static func requester(_ registration: [String: Any]) -> String? {
    guard let publisher = registration["publisher"] as? String, let app = registration["appId"] as? String,
      let version = registration["version"] as? String, let session = registration["sessionId"] as? String else { return nil }
    return "Napplet: \(app)\nPublisher: \(publisher)\nVersion: \(version)\nSession: \(session)"
  }
  public static func capture(kind: String, token: String) -> NativeSigningSourceCapture? {
    guard token.utf8.count == 36, UUID(uuidString: token) != nil else { return nil }
    switch kind {
    case "approval":
      let registry = ApprovalTransport.registry
      guard let raw = registry.signingSnapshot(token),
        let object = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
        let registration = object["registration"] as? [String: Any], let identity = registration["user"] as? String,
        let description = requester(registration), let event = object["event"], let destinations = object["destinations"] as? [String],
        let data = try? JSONSerialization.data(withJSONObject: event, options: .withoutEscapingSlashes) else { return nil }
      return NativeSigningSourceCapture(identity: identity, requester: description, destinations: destinations,
        eventJSON: String(decoding: data, as: UTF8.self), live: { registry.isSigningLive(token) },
        claim: { registry.claimNativeSigning(token, expected: raw) }, cancel: { registry.cancel(token) }, pause: { registry.pauseNativeSigning(token, paused: $0) })
    case "upload":
      let registry = UploadTransport.leases
      guard let captured = registry.signingCapture(token),
        let registration = try? JSONSerialization.jsonObject(with: Data(captured.registration.utf8)) as? [String: Any],
        let description = requester(registration) else { return nil }
      return NativeSigningSourceCapture(identity: captured.review.identity, requester: description,
        destinations: [captured.review.destination], eventJSON: nil, uploadHash: captured.review.sha256,
        uploadSize: captured.review.size, uploadType: captured.review.mimeType,
        live: { registry.nativeSigningLifetime(token) || registry.isLive(token) }, claim: { registry.claimNativeSigning(token, expected: captured.review) },
        cancel: { registry.cancel(token) }, pause: { registry.pauseNativeSigning(token, paused: $0) })
    case "fixture-upload", "fixture-manifest":
      let owner = FixtureReleaseTransport.shared.owner, manifest = kind == "fixture-manifest"
      guard let row = owner.current(token),
        manifest ? owner.manifestApproved(token) : owner.uploadApproved(token) else { return nil }
      if manifest {
        guard let raw = row.manifestSnapshot,
          let object = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
          var event = object["event"] as? [String: Any], let destinations = object["relays"] as? [String] else { return nil }
        event["pubkey"] = row.identity
        guard let data = try? JSONSerialization.data(withJSONObject: event, options: .withoutEscapingSlashes) else { return nil }
        return NativeSigningSourceCapture(identity: row.identity, requester: "Trusted fixture publisher: \(row.fixture)",
          destinations: destinations, eventJSON: String(decoding: data, as: UTF8.self),
          live: { owner.nativeSigningLifetime(token, manifest: true) || owner.manifestApproved(token) }, claim: { owner.claimNativeSigning(token, manifest: true) }, cancel: { owner.cancel() }, pause: { owner.pauseNativeSigning(token, manifest: true, paused: $0) })
      }
      return NativeSigningSourceCapture(identity: row.identity, requester: "Trusted fixture publisher: \(row.fixture)",
        destinations: [row.server], eventJSON: nil, uploadHash: row.review.sha256, uploadSize: row.review.size, uploadType: row.review.mimeType,
        live: { owner.nativeSigningLifetime(token, manifest: false) || owner.uploadApproved(token) }, claim: { owner.claimNativeSigning(token, manifest: false) }, cancel: { owner.cancel() }, pause: { owner.pauseNativeSigning(token, manifest: false, paused: $0) })
    default: return nil
    }
  }
  /// Native method/account transitions revoke pending sources independently of JS lifecycle delivery.
  public static func revokeAll() {
    ApprovalTransport.registry.cancelAllSigningSources()
    UploadTransport.leases.revokeAll()
    FixtureReleaseTransport.shared.cancel()
  }
  public static func cancel(kind: String, token: String) {
    switch kind {
    case "approval": ApprovalTransport.cancel(token)
    case "upload": UploadTransport.leases.cancel(token)
    case "fixture-upload", "fixture-manifest": if FixtureReleaseTransport.shared.owner.current(token) != nil { FixtureReleaseTransport.shared.cancel() }
    default: break
    }
  }
}
