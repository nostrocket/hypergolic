import Foundation
import ExpoModulesCore

public final class NappletHostModule: Module {
  private let publishedHTTPS = PublishedHTTPSBridgeOwner()
  private let publishedRelay = PublishedRelayBridgeOwner()
  private let relayStreams = RelayStreamBridgeOwner.shared
  deinit {
    UploadTransport.foreground(false)
    FixtureReleaseTransport.shared.cancel()
    publishedHTTPS.revokeAll()
    ResourceHTTPSBridgeOwner.shared.revokeAll()
    publishedRelay.revokeAll()
    relayStreams.setForeground(false)
    PublishedArtifactTransfer.shared.revokeAll()
  }

  public func definition() -> ModuleDefinition {
    let publishedHTTPS = self.publishedHTTPS
    let publishedRelay = self.publishedRelay
    let relayStreams = self.relayStreams
    // Matches Expo 57's EventEmitter adapter: this captured identity is used only by emit,
    // which schedules payload conversion and module lookup on Expo's JavaScriptActor.
    nonisolated(unsafe) weak let streamEmitter = self
    Name("HypergolicNappletHost")
    Events("onRelayStream", "onRelayLifecycle", "onUploadProgress", "onRoutingLifecycle")
    OnCreate {
      UploadTransport.observeProgress { event in streamEmitter?.emit(event: "onUploadProgress", payload: ["token": event.token, "bytesSent": event.bytesSent, "bytesTotal": event.bytesTotal]) }
      RoutingTransport.shared.observeLifecycle { snapshot in streamEmitter?.emit(event: "onRoutingLifecycle", payload: ["snapshot": snapshot]) }
      _ = CapabilityTransport.lifecycle
      RelaySubscriptionTransport.shared.observeLifecycle { snapshot in streamEmitter?.emit(event: "onRelayLifecycle", payload: ["snapshot": snapshot]) }
    }
    OnDestroy {
      RoutingTransport.shared.observeLifecycle(nil)
      UploadTransport.observeProgress(nil)
      CapabilityTransport.foreground(false)
      RelaySubscriptionTransport.shared.observeLifecycle(nil)
    }
    Function("synchronizeLinkOwner") { (user: String, epoch: Double, available: Bool) throws in
      guard user.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
        epoch.isFinite, epoch >= 0, epoch <= 9_007_199_254_740_991, epoch.rounded(.towardZero) == epoch,
        LinkTransport.synchronizeOwner(user, epoch: UInt64(epoch), available: available) else {
        throw NSError(domain: "HypergolicLinkOwner", code: 1)
      }
    }
    Function("relayLifecycle") { RelaySubscriptionTransport.shared.lifecycle() }
    Function("startRelayStream") { (id: String, token: String, url: String, request: String, subId: String) -> Bool in
      relayStreams.start(id, token: token, url: url, request: request, subId: subId) { event in streamEmitter?.emit(event: "onRelayStream", payload: event.payload) }
    }
    Function("acknowledgeRelayStream") { (id: String, sequence: UInt64) in relayStreams.acknowledge(id, sequence: sequence) }
    Function("cancelRelayStream") { (id: String) in relayStreams.cancel(id) }
    Function("synchronizeFixturePublisher") { (user: String, epoch: Double, available: Bool) throws in
      guard epoch.isFinite, epoch >= 0, epoch <= 9_007_199_254_740_991, epoch.rounded(.towardZero) == epoch else {throw UploadWire.Invalid.value}
      try FixtureReleaseTransport.shared.synchronize(user,epoch:UInt64(epoch),available:available)
    }
    Function("prepareFixtureUpload") { (fixture: String, server: String) throws -> String in try FixtureReleaseTransport.shared.prepare(fixture,server:server) }
    Function("approveFixtureUpload") { (token: String) -> Bool in FixtureReleaseTransport.shared.approveUpload(token) }
    Function("isFixtureUploadApproved") { (token: String) -> Bool in FixtureReleaseTransport.shared.uploadApproved(token) }
    Function("prepareFixtureManifest") { (token: String, relays: [String]) throws -> String in try FixtureReleaseTransport.shared.prepareManifest(token,relays:relays) }
    Function("approveFixtureManifest") { (token: String) -> String? in FixtureReleaseTransport.shared.approveManifest(token) }
    Function("isFixtureManifestApproved") { (token: String) -> Bool in FixtureReleaseTransport.shared.manifestApproved(token) }
    Function("cancelFixtureRelease") { FixtureReleaseTransport.shared.cancel() }
    AsyncFunction("putFixtureUpload") { (token: String, credential: String) async -> String in await FixtureReleaseTransport.shared.put(token,credential:credential) }
    Function("configureUploadProof") { (anchor: String) throws in try UploadTransport.configureProof(anchor) }
    Function("configureUploadServer") { (server: String?) throws in try UploadTransport.configure(server) }
    Function("listUploadRecovery") { () -> String in UploadTransport.listRecovery() }
    AsyncFunction("checkUploadRecovery") { (uploadId: String) async -> String in await UploadTransport.checkRecovery(uploadId) }
    Function("takeUpload") { (token: String) -> String? in UploadTransport.take(token) }
    Function("isUploadLive") { (token: String) -> Bool in UploadTransport.leases.isLive(token) }
    Function("mayReviewUpload") { (token: String) -> Bool in UploadTransport.leases.mayReview(token) }
    Function("readUploadPreview") { (token: String, offset: Int) -> String? in UploadTransport.leases.preview(token, offset: offset)?.base64EncodedString() }
    Function("approveUpload") { (token: String) -> Bool in UploadTransport.leases.approve(token) }
    Function("isUploadApproved") { (token: String) -> Bool in UploadTransport.leases.isApproved(token) }
    Function("claimUploadSigning") { (token: String) -> Bool in UploadTransport.leases.claimSigning(token) }
    Function("wasUploadDispatched") { (token: String) -> Bool in UploadTransport.leases.wasDispatched(token) }
    Function("cancelUpload") { (token: String) in UploadTransport.cancel(token) }
    Function("finishUpload") { (token: String, result: String) in UploadTransport.finish(token, raw: result) }
    AsyncFunction("putUpload") { (token: String, credential: String) async -> String in await UploadTransport.put(token, credential: credential) }
    AsyncFunction("fetchResourceHttps") { (token: String, operationId: String, url: String) async -> String in
      var result: [String: Any]
      do {
        let length = try await ResourceHTTPSBridgeOwner.shared.fetch(operationId, token: token, url: url)
        result = ["ok": true, "length": length]
      } catch {
        let code: String
        switch error {
        case ResourceHTTPSBridgeOwner.Failure.policy: code = "blocked-by-policy"
        case ResourceHTTPSBridgeOwner.Failure.invalidRequest: code = "invalid-request"
        case ResourceHTTPSBridgeOwner.Failure.quota: code = "quota-exceeded"
        case ResourceHTTPSBridgeOwner.Failure.timeout: code = "timeout"
        case PublishedHTTPResponse.Failure.resourcePolicy: code = "blocked-by-policy"
        case PublishedHTTPResponse.Failure.tooLarge: code = "too-large"
        case PublishedHTTPResponse.Failure.resourceStatus(let status):
          code = status == 404 ? "not-found" : ((300...399).contains(status) || status == 401 || status == 403 ? "blocked-by-policy" : "network-error")
        case PublishedPinnedHTTPS.Failure.privateAddress, PublishedPinnedHTTPS.Failure.invalidURL: code = "blocked-by-policy"
        case PublishedPinnedHTTPS.Failure.cancelled: code = "timeout"
        default: code = "network-error"
        }
        result = ["ok": false, "error": code]
      }
      return String(decoding: (try? JSONSerialization.data(withJSONObject: result)) ?? Data(), as: UTF8.self)
    }
    Function("readResourceHttpsChunk") { (token: String, operationId: String, offset: Int) -> String? in
      try? ResourceHTTPSBridgeOwner.shared.read(operationId, token: token, offset: offset)
    }
    Function("cancelResourceHttps") { (operationId: String) in ResourceHTTPSBridgeOwner.shared.cancel(operationId) }
    AsyncFunction("fetchPublishedHttps") { (operationId: String, url: String) async throws -> String in
      try await publishedHTTPS.fetch(operationId: operationId, url: url)
    }
    Function("cancelPublishedHttps") { (operationId: String) in
      publishedHTTPS.cancel(operationId: operationId)
    }
    Function("revokeAllPublishedHttps") { publishedHTTPS.revokeAll() }
    AsyncFunction("queryPublishedRelay") { (operationId: String, url: String, requestText: String,
                                              subscriptionId: String) async throws -> [String] in
      try await publishedRelay.query(operationId: operationId, url: url, requestText: requestText,
                                      subscriptionId: subscriptionId)
    }
    Function("cancelPublishedRelay") { (operationId: String) in
      publishedRelay.cancel(operationId: operationId)
    }
    Function("revokeAllPublishedRelay") { publishedRelay.revokeAll() }
    Function("newInstanceId") { UUID().uuidString.lowercased() }
    Function("takeSubscription") { (token: String) -> String? in RelaySubscriptionTransport.shared.registry.take(token) }
    Function("acceptSubscription") { (token: String) -> Bool in RelaySubscriptionTransport.shared.registry.accept(token) }
    Function("mayDeliverSubscription") { (token: String) -> Bool in RelaySubscriptionTransport.shared.registry.mayDeliver(token) }
    Function("isSubscriptionActive") { (token: String) -> Bool in RelaySubscriptionTransport.shared.registry.isActive(token) }
    Function("subscriptionCapacity") { (token: String) -> Bool in RelaySubscriptionTransport.shared.hasCapacity(token) }
    Function("sendSubscription") { (token: String, response: String) -> Int in RelaySubscriptionTransport.shared.send(token, response: response) }
    Function("closeSubscription") { (token: String) in RelaySubscriptionTransport.shared.close(token) }
    Function("synchronizeRoutingOwner") { (user: String, epoch: Double, available: Bool) throws in
      guard epoch.isFinite, epoch >= 0, epoch <= 9_007_199_254_740_991, epoch.rounded(.towardZero) == epoch,
        RoutingTransport.shared.synchronizeOwner(user, epoch: UInt64(epoch), available: available) else { throw NSError(domain: "HypergolicRoutingOwner", code: 1) }
    }
    Function("routingState") { RoutingTransport.shared.state() }
    Function("mayReviewRouting") { (generation: String, revision: UInt64) -> Bool in RoutingTransport.shared.mayReview(generation, revision: revision) }
    Function("routingReviewRevision") { (generation: String, revision: UInt64) -> Int64 in RoutingTransport.shared.reviewRevision(generation, revision: revision) }
    Function("mayDeliverRouting") { (generation: String, revision: UInt64, domain: String) -> Bool in RoutingTransport.shared.mayDeliver(generation, revision: revision, domain: domain) }
    Function("sendRouting") { (generation: String, revision: UInt64, response: String) -> Bool in RoutingTransport.shared.send(generation, revision: revision, raw: response) }
    Function("takeCapability") { (token: String) -> String? in CapabilityTransport.leases.take(token) }
    Function("isCapabilityActive") { (token: String) -> Bool in CapabilityTransport.leases.isActive(token) }
    Function("replaceIdentityListAccess") { (raw: String) throws in try IdentityListAccess.shared.replaceJSON(raw) }
    Function("finishCapability") { (token: String, response: String?) in CapabilityTransport.finish(token, response: response) }
    Function("takeApproval") { (token: String) -> String? in ApprovalTransport.take(token) }
    Function("prepareApprovalSigning") { (token: String, snapshot: String) -> Bool in
      ApprovalTransport.registry.prepareSigning(token, raw: snapshot)
    }
    Function("prepareOutboxApproval") { (token: String, plan: String) -> Bool in ApprovalTransport.registry.prepareOutbox(token, raw: plan) }
    Function("failOutboxApproval") { (token: String, error: String) in ApprovalTransport.registry.failOutbox(token, error: error) }
    AsyncFunction("publishOutboxApproval") { (token: String, group: String, event: String, relay: String) async throws -> String in
      try await OutboxPublicationOwner.shared.publish(token: token, group: group, event: event, relay: relay)
    }
    Function("isApprovalLive") { (token: String) -> Bool in ApprovalTransport.isLive(token) }
    Function("mayReviewApproval") { (token: String) -> Bool in ApprovalTransport.mayReview(token) }
    Function("approveApproval") { (token: String) -> Bool in ApprovalTransport.approve(token) }
    Function("isApprovalApproved") { (token: String) -> Bool in ApprovalTransport.isApproved(token) }
    Function("cancelApproval") { (token: String) in ApprovalTransport.cancel(token) }
    Function("dismissApproval") { (token: String) in ApprovalTransport.dismiss(token) }
    Function("finishApproval") { (token: String, response: String?) in ApprovalTransport.finish(token, response: response) }
    Function("resumeApprovals") { ApprovalTransport.resume() }
    Function("registerPublishedSession") { (sessionId: String) -> Bool in
      PublishedArtifactTransfer.shared.registerPublishedSession(sessionId)
    }
    Function("beginPublishedArtifact") { (sessionId: String, publisher: String, identifier: String,
                                          eventId: String, aggregateHash: String, htmlHash: String,
                                          byteLength: Int) -> String? in
      PublishedArtifactTransfer.shared.beginPublishedArtifact(
        sessionId: sessionId, publisher: publisher, identifier: identifier, eventId: eventId,
        aggregateHash: aggregateHash, htmlHash: htmlHash, byteLength: byteLength)
    }
    Function("appendPublishedArtifact") { (uploadId: String, sequence: Int, base64Chunk: String) -> Bool in
      PublishedArtifactTransfer.shared.appendPublishedArtifact(uploadId, sequence: sequence, base64Chunk: base64Chunk)
    }
    Function("finishPublishedArtifact") { (uploadId: String) -> String? in
      PublishedArtifactTransfer.shared.finishPublishedArtifact(uploadId)
    }
    Function("cancelPublishedArtifact") { (uploadId: String) in
      PublishedArtifactTransfer.shared.cancelPublishedArtifact(uploadId)
    }
    Function("revokePublishedSession") { (sessionId: String) in
      PublishedArtifactTransfer.shared.revokePublishedSession(sessionId)
    }
    Function("revokeAllPublishedArtifacts") { PublishedArtifactTransfer.shared.revokeAll() }
    View(NappletHostView.self) {
      Events("onHostEvent")
      Prop("pickerFaultProof") { (view: NappletHostView, action: String) in view.armPickerFaultProof(action) }
      Prop("uploadFaultProof") { (view: NappletHostView, action: String) in view.armUploadFaultProof(action) }
      Prop("closeCheck") { (view: NappletHostView, raw: String) in view.setCloseCheck(raw) }
      Prop("active") { (view: NappletHostView, active: Bool) in
        view.setActive(active)
      }
      Prop("configuration") { (view: NappletHostView, raw: String) in
        view.startConfiguredSession(raw)
      }
      Prop("publishedArtifact") { (view: NappletHostView, raw: String) in
        view.startPublishedArtifact(raw)
      }
      Prop("sessionId") { (view: NappletHostView, id: String) in
        view.startSession(id)
      }
    }
  }
}
