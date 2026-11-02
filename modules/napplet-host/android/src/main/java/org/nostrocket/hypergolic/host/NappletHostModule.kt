package org.nostrocket.hypergolic.host

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import com.facebook.react.common.LifecycleState
import android.util.Base64
import expo.modules.kotlin.functions.Coroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext

class NappletHostModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HypergolicNappletHost")
    Events("onRelayStream", "onRelayLifecycle", "onUploadProgress", "onRoutingLifecycle")
    OnCreate {
      RoutingTransport.observeLifecycle { snapshot -> sendEvent("onRoutingLifecycle", mapOf("snapshot" to snapshot)) }
      UploadTransport.configureRecovery(appContext.runtime.reactContext?.noBackupFilesDir)
      UploadTransport.observeProgress { event -> sendEvent("onUploadProgress", event) }
      RelaySubscriptionTransport.observeLifecycle { snapshot -> sendEvent("onRelayLifecycle", mapOf("snapshot" to snapshot)) }
      val foreground = appContext.runtime.reactContext?.lifecycleState == LifecycleState.RESUMED
      SelectedFilePicker.foreground(foreground)
      UploadTransport.foreground(foreground)
      FixtureReleaseTransport.foreground(foreground)
      CapabilityTransport.foreground(foreground)
      NappletHostView.setMediaForeground(foreground)
      ApprovalTransport.foreground(foreground)
      RelaySubscriptionTransport.foreground(foreground)
      PublishedHttpsRequestOwner.INSTANCE.setForeground(foreground)
      ResourceHttpsRequestOwner.INSTANCE.setForeground(foreground)
      PublishedRelayWssRequestOwner.INSTANCE.setForeground(foreground)
    }
    OnActivityEntersForeground {
      SelectedFilePicker.foreground(true)
      UploadTransport.foreground(true)
      FixtureReleaseTransport.foreground(true)
      CapabilityTransport.foreground(true)
      NappletHostView.setMediaForeground(true)
      ApprovalTransport.foreground(true)
      RelaySubscriptionTransport.foreground(true)
      PublishedHttpsRequestOwner.INSTANCE.setForeground(true)
      ResourceHttpsRequestOwner.INSTANCE.setForeground(true)
      PublishedRelayWssRequestOwner.INSTANCE.setForeground(true)
    }
    OnActivityEntersBackground {
      SelectedFilePicker.foreground(false)
      UploadTransport.foreground(false)
      FixtureReleaseTransport.foreground(false)
      CapabilityTransport.foreground(false)
      NappletHostView.setMediaForeground(false)
      ApprovalTransport.foreground(false)
      RelaySubscriptionTransport.foreground(false)
      PublishedHttpsRequestOwner.INSTANCE.setForeground(false)
      ResourceHttpsRequestOwner.INSTANCE.setForeground(false)
      PublishedRelayWssRequestOwner.INSTANCE.setForeground(false)
      PublishedArtifactTransfer.INSTANCE.revokeAllPublishedArtifacts()
      // Verified loaded read views retain their generation; pending transfers are revoked above.
    }
    OnActivityResult { activity, result -> SelectedFilePicker.result(activity, result.requestCode, result.resultCode, result.data) }
    OnActivityDestroys {
      SelectedFilePicker.cancel()
      SelectedFilePicker.foreground(false)
      UploadTransport.foreground(false)
      FixtureReleaseTransport.foreground(false)
      CapabilityTransport.foreground(false)
      NappletHostView.setMediaForeground(false)
      ApprovalTransport.foreground(false)
      RelaySubscriptionTransport.foreground(false)
      PublishedHttpsRequestOwner.INSTANCE.setForeground(false)
      ResourceHttpsRequestOwner.INSTANCE.setForeground(false)
      PublishedRelayWssRequestOwner.INSTANCE.setForeground(false)
      PublishedArtifactTransfer.INSTANCE.revokeAllPublishedArtifacts()
      NappletHostView.revokePublishedOnBackground()
    }
    OnUserLeavesActivity {
      SelectedFilePicker.cancel()
      SelectedFilePicker.foreground(false)
      UploadTransport.foreground(false)
      FixtureReleaseTransport.foreground(false)
      CapabilityTransport.foreground(false)
      NappletHostView.setMediaForeground(false)
      RelaySubscriptionTransport.foreground(false)
      PublishedHttpsRequestOwner.INSTANCE.setForeground(false)
      ResourceHttpsRequestOwner.INSTANCE.setForeground(false)
      PublishedRelayWssRequestOwner.INSTANCE.setForeground(false)
    }
    OnDestroy {
      SelectedFilePicker.cancel()
      RoutingTransport.observeLifecycle(null)
      UploadTransport.observeProgress(null)
      SelectedFilePicker.foreground(false)
      UploadTransport.foreground(false)
      FixtureReleaseTransport.foreground(false)
      CapabilityTransport.foreground(false)
      RelaySubscriptionTransport.foreground(false)
      RelaySubscriptionTransport.revokeAll()
      RelaySubscriptionTransport.observeLifecycle(null)
      PublishedRelayWssRequestOwner.INSTANCE.setForeground(false)
      PublishedHttpsRequestOwner.INSTANCE.revokeAll()
      ResourceHttpsRequestOwner.INSTANCE.revokeAll()
      PublishedRelayWssRequestOwner.INSTANCE.revokeAll()
    }
    Function("synchronizeFixturePublisher") { user: String, epoch: Long, available: Boolean -> FixtureReleaseTransport.synchronize(user,epoch,available) }
    Function("prepareFixtureUpload") { fixture: String, server: String ->
      FixtureReleaseTransport.prepare(requireNotNull(appContext.runtime.reactContext),fixture,server) }
    Function("approveFixtureUpload") { token: String -> FixtureReleaseTransport.approveUpload(token) }
    Function("isFixtureUploadApproved") { token: String -> FixtureReleaseTransport.uploadApproved(token) }
    Function("prepareFixtureManifest") { token: String, relays: List<String> -> FixtureReleaseTransport.prepareManifest(token,relays) }
    Function("approveFixtureManifest") { token: String -> FixtureReleaseTransport.approveManifest(token) }
    Function("isFixtureManifestApproved") { token: String -> FixtureReleaseTransport.manifestApproved(token) }
    Function("cancelFixtureRelease") { FixtureReleaseTransport.cancel() }
    AsyncFunction("putFixtureUpload") Coroutine { token: String, credential: String ->
      try { withContext(Dispatchers.IO) { FixtureReleaseTransport.put(token,credential) } }
      catch(error: kotlinx.coroutines.CancellationException) { FixtureReleaseTransport.cancel();throw error }
    }
    Function("configureUploadProof") { anchor: String -> UploadTransport.configureProof(anchor) }
    Function("configureUploadServer") { server: String? -> UploadTransport.configure(server) }
    Function("listUploadRecovery") { UploadTransport.listRecovery() }
    AsyncFunction("checkUploadRecovery") Coroutine { uploadId: String -> withContext(Dispatchers.IO) { UploadTransport.checkRecovery(uploadId) } }
    Function("takeUpload") { token: String -> UploadTransport.take(token) }
    Function("isUploadLive") { token: String -> UploadTransport.leases.isLive(token) }
    Function("mayReviewUpload") { token: String -> UploadTransport.leases.mayReview(token) }
    Function("readUploadPreview") { token: String, offset: Int -> UploadTransport.leases.preview(token, offset)?.let { Base64.encodeToString(it, Base64.NO_WRAP) } }
    Function("approveUpload") { token: String -> UploadTransport.leases.approve(token) }
    Function("isUploadApproved") { token: String -> UploadTransport.leases.isApproved(token) }
    Function("claimUploadSigning") { token: String -> UploadTransport.leases.claimSigning(token) }
    Function("wasUploadDispatched") { token: String -> UploadTransport.leases.wasDispatched(token) }
    Function("cancelUpload") { token: String -> UploadTransport.cancel(token) }
    Function("finishUpload") { token: String, result: String -> UploadTransport.finish(token, result) }
    AsyncFunction("putUpload") Coroutine { token: String, credential: String ->
      try { withContext(Dispatchers.IO) { UploadTransport.put(token, credential) } }
      catch (error: kotlinx.coroutines.CancellationException) { UploadTransport.cancel(token); throw error }
    }
    AsyncFunction("fetchResourceHttps") Coroutine { token: String, operationId: String, url: String ->
      val generation = ResourceCapability.admission(token)
      val job = currentCoroutineContext()[Job]
      withContext(Dispatchers.IO) {
        val result = org.json.JSONObject()
        if (generation == null) result.put("ok", false).put("error", "blocked-by-policy")
        else try {
          val length = ResourceHttpsRequestOwner.INSTANCE.fetch(operationId, token, generation, url,
            { CapabilityTransport.leases.isActive(token) }, { job?.isActive == true })
          result.put("ok", true).put("length", length)
        } catch (error: ResourceHttpsRequestOwner.Failure) { result.put("ok", false).put("error", error.code) }
        catch (_: Exception) { result.put("ok", false).put("error", "network-error") }
        result.toString()
      }
    }
    Function("readResourceHttpsChunk") { token: String, operationId: String, offset: Int ->
      try { Base64.encodeToString(ResourceHttpsRequestOwner.INSTANCE.read(operationId, token, offset), Base64.NO_WRAP) }
      catch (_: Exception) { null }
    }
    Function("cancelResourceHttps") { operationId: String -> ResourceHttpsRequestOwner.INSTANCE.cancel(operationId) }
    AsyncFunction("fetchPublishedHttps") Coroutine { operationId: String, url: String ->
      val job = currentCoroutineContext()[Job]
      withContext(Dispatchers.IO) {
        val bytes = PublishedHttpsRequestOwner.INSTANCE.fetch(operationId, url) { job?.isActive == true }
        Base64.encodeToString(bytes, Base64.NO_WRAP)
      }
    }
    Function("cancelPublishedHttps") { operationId: String ->
      PublishedHttpsRequestOwner.INSTANCE.cancel(operationId)
    }
    Function("revokeAllPublishedHttps") { PublishedHttpsRequestOwner.INSTANCE.revokeAll()
      ResourceHttpsRequestOwner.INSTANCE.revokeAll() }
    AsyncFunction("queryPublishedRelay") Coroutine { operationId: String, url: String, requestText: String,
      subscriptionId: String ->
      val job = currentCoroutineContext()[Job]
      withContext(Dispatchers.IO) {
        PublishedRelayWssRequestOwner.INSTANCE.query(operationId, url, requestText, subscriptionId) {
          job?.isActive == true
        }
      }
    }
    Function("cancelPublishedRelay") { operationId: String ->
      PublishedRelayWssRequestOwner.INSTANCE.cancel(operationId)
    }
    Function("revokeAllPublishedRelay") { PublishedRelayWssRequestOwner.INSTANCE.revokeAll() }
    Function("registerPublishedSession") { sessionId: String ->
      PublishedArtifactTransfer.INSTANCE.registerPublishedSession(sessionId)
    }
    Function("beginPublishedArtifact") { sessionId: String, publisher: String, identifier: String,
      eventId: String, aggregateHash: String, htmlHash: String, byteLength: Int ->
      PublishedArtifactTransfer.INSTANCE.beginPublishedArtifact(
        sessionId, publisher, identifier, eventId, aggregateHash, htmlHash, byteLength)
    }
    Function("appendPublishedArtifact") { uploadId: String, sequence: Int, base64Chunk: String ->
      PublishedArtifactTransfer.INSTANCE.appendPublishedArtifact(uploadId, sequence, base64Chunk)
    }
    Function("finishPublishedArtifact") { uploadId: String ->
      PublishedArtifactTransfer.INSTANCE.finishPublishedArtifact(uploadId)
    }
    Function("cancelPublishedArtifact") { uploadId: String ->
      PublishedArtifactTransfer.INSTANCE.cancelPublishedArtifact(uploadId)
    }
    Function("revokePublishedSession") { sessionId: String ->
      PublishedArtifactTransfer.INSTANCE.revokePublishedSession(sessionId)
    }
    Function("revokeAllPublishedArtifacts") {
      PublishedArtifactTransfer.INSTANCE.revokeAllPublishedArtifacts()
    }
    Function("takeApproval") { token: String -> ApprovalTransport.leases.take(token) }
    Function("prepareApprovalSigning") { token: String, snapshot: String -> NativeSigningSourceFacade.prepareApproval(token,snapshot) }
    Function("prepareOutboxApproval") { token: String, plan: String -> ApprovalTransport.prepareOutbox(token, plan) }
    Function("failOutboxApproval") { token: String, error: String -> ApprovalTransport.failOutbox(token, error) }
    AsyncFunction("publishOutboxApproval") Coroutine { token: String, group: String, event: String, relay: String ->
      val job = currentCoroutineContext()[Job]
      withContext(Dispatchers.IO) { OutboxPublicationOwner.publish(token, group, event, relay) { job?.isActive == true } }
    }
    Function("isApprovalLive") { token: String -> ApprovalTransport.leases.isLive(token) }
    Function("mayReviewApproval") { token: String -> ApprovalTransport.leases.mayReview(token) }
    Function("approveApproval") { token: String -> ApprovalTransport.leases.approve(token) }
    Function("isApprovalApproved") { token: String -> ApprovalTransport.leases.isApproved(token) }
    Function("dismissApproval") { token: String -> ApprovalTransport.dismiss(token) }
    Function("cancelApproval") { token: String -> ApprovalTransport.cancel(token) }
    Function("finishApproval") { token: String, response: String? -> ApprovalTransport.finish(token, response) }
    Function("resumeApprovals") { ApprovalTransport.resume() }
    Function("newInstanceId") { java.util.UUID.randomUUID().toString() }
    Function("synchronizeLinkOwner") { user: String, epoch: Double, available: Boolean ->
      require(user.matches(Regex("[0-9a-f]{64}")) && epoch.isFinite() && epoch >= 0 && epoch <= 9_007_199_254_740_991.0 && epoch % 1.0 == 0.0)
      check(LinkTransport.synchronizeOwner(user, epoch.toLong(), available)) { "Stale link owner" }
    }
    Function("relayLifecycle") { RelaySubscriptionTransport.lifecycle() }
    Function("startRelayStream") { id: String, token: String, url: String, request: String, subId: String ->
      RelayStreamWssOwner.start(id, token, url, request, subId) { event -> sendEvent("onRelayStream", event) }
    }
    Function("acknowledgeRelayStream") { id: String, sequence: Long -> RelayStreamWssOwner.acknowledge(id, sequence) }
    Function("cancelRelayStream") { id: String -> RelayStreamWssOwner.cancel(id) }
    Function("takeSubscription") { token: String -> RelaySubscriptionTransport.registry.take(token) }
    Function("acceptSubscription") { token: String -> RelaySubscriptionTransport.registry.accept(token) }
    Function("mayDeliverSubscription") { token: String -> RelaySubscriptionTransport.registry.mayDeliver(token) }
    Function("isSubscriptionActive") { token: String -> RelaySubscriptionTransport.registry.isActive(token) }
    Function("subscriptionCapacity") { token: String -> RelaySubscriptionTransport.hasCapacity(token) }
    Function("sendSubscription") { token: String, response: String -> RelaySubscriptionTransport.send(token, response) }
    Function("closeSubscription") { token: String -> RelaySubscriptionTransport.close(token) }
    Function("synchronizeRoutingOwner") { user: String, epoch: Long, available: Boolean ->
      require(RoutingTransport.synchronizeOwner(user, epoch, available)) { "Routing owner unavailable" }
    }
    Function("routingState") { RoutingTransport.state() }
    Function("mayReviewRouting") { generation: String, revision: Long -> RoutingTransport.mayReview(generation, revision) }
    Function("routingReviewRevision") { generation: String, revision: Long -> RoutingTransport.reviewRevision(generation, revision) }
    Function("mayDeliverRouting") { generation: String, revision: Long, domain: String -> RoutingTransport.mayDeliver(generation, revision, domain) }
    Function("sendRouting") { generation: String, revision: Long, response: String -> RoutingTransport.send(generation, revision, response) }
    Function("takeCapability") { token: String -> CapabilityTransport.leases.take(token) }
    Function("isCapabilityActive") { token: String -> CapabilityTransport.leases.isActive(token) }
    Function("replaceIdentityListAccess") { raw: String -> IdentityListAccess.replace(raw) }
    Function("finishCapability") { token: String, response: String? -> CapabilityTransport.finish(token, response) }
    View(NappletHostView::class) {
      Events("onHostEvent")
      Prop("pickerFaultProof") { view: NappletHostView, action: String -> view.armPickerFaultProof(action) }
      Prop("uploadFaultProof") { view: NappletHostView, action: String -> view.armUploadFaultProof(action) }
      Prop("configuration") { view: NappletHostView, raw: String -> view.startConfiguredSession(raw) }
      Prop("publishedArtifact") { view: NappletHostView, raw: String -> view.startPublishedArtifact(raw) }
      Prop("sessionId") { view: NappletHostView, id: String -> view.startSession(id) }
      Prop("closeCheck") { view: NappletHostView, raw: String -> view.setCloseCheck(raw) }
      Prop("active") { view: NappletHostView, active: Boolean -> view.setActive(active) }
      OnViewDestroys { view: NappletHostView -> view.destroySession() }
    }
    View(ShellGestureRegionView::class) {
      Name("ShellGestureRegion")
      Prop("active") { view: ShellGestureRegionView, active: Boolean -> view.setHandleActive(active) }
      OnViewDestroys { view: ShellGestureRegionView -> view.setHandleActive(false) }
    }
  }
}
