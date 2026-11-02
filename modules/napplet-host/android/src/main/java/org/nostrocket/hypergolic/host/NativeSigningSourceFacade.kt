package org.nostrocket.hypergolic.host

import java.util.function.Supplier
import org.json.JSONArray
import org.json.JSONObject

/** Native-only source capture. JS preparation flags correlate work; only the native signer button grants consent. */
object NativeSigningSourceFacade {
  class Capture internal constructor(val identity: String,val unsigned: String,val requester: String,val destinations: List<String>,
    private val monitor: Any,private val valid: () -> Boolean,private val claim: () -> Boolean,
    private val hold: (Long) -> NativeSigningHold?, private val held: (NativeSigningHold) -> Boolean,
    private val resume: (NativeSigningHold) -> Boolean) {
    private var consumed = false
    private var handoff: NativeSigningHold? = null
    /** Only native browser/activity consent calls this after the native signing claim. */
    fun armHandoff(deadline: Long): Boolean = synchronized(monitor) {
      if (!consumed || !valid() || handoff != null) false
      else hold(deadline)?.also { handoff = it } != null
    }
    fun handoffActive(): Boolean = synchronized(monitor) { handoff?.let(held) == true }
    fun resumeHandoff(accepted: () -> Boolean): Boolean = synchronized(monitor) {
      val value = handoff
      value != null && held(value) && accepted() && resume(value)
    }
    fun cancelCurrent(effect: () -> Unit) = synchronized(monitor) {
      if (valid() || handoff?.let(held) == true) effect()
    }
    fun cancelHandoff(effect: () -> Unit) = synchronized(monitor) {
      if (handoff?.let(held) == true) effect()
    }
    fun resumedHandoff(): Boolean = synchronized(monitor) { handoff?.let(held) == true && valid() }
    fun active(): Boolean=synchronized(monitor) { valid() }
    fun perform(effect: Runnable) = synchronized(monitor) {
      require(consumed && valid())
      effect.run()
      require(valid())
    }
    fun sign(effect: Supplier<String>): String=synchronized(monitor) {
      require(!consumed && valid() && claim()); consumed = true
      val value=effect.get();require(valid());value
    }
  }
  @JvmStatic fun prepareApproval(token: String,snapshot: String): Boolean=runCatching {
    synchronized(ApprovalTransport.leases) {
      val source=ApprovalTransport.leases.claimedSnapshot(token) ?: return false
      val captured=NativeApprovalSigningData.capture(source,snapshot,ApprovalTransport.leases.prepared(token))
      ApprovalTransport.leases.prepareSigning(token,captured)
    }
  }.getOrDefault(false)
  @JvmStatic fun capture(kind: String,token: String,unsigned: String): Capture {
    require(token.length in 1..128)
    return when(kind) {
      "approval" -> synchronized(ApprovalTransport.leases) {
        val metadata=ApprovalTransport.leases.signingPrepared(token) as? NativeApprovalSigningData ?: error("Native source unavailable")
        require(ApprovalTransport.leases.signingFresh(token,metadata))
        Capture(metadata.user,metadata.unsigned(),metadata.requester,metadata.destinations,ApprovalTransport.leases,
          { ApprovalTransport.leases.isApproved(token) && ApprovalTransport.leases.signingPrepared(token)===metadata },
          { ApprovalTransport.leases.claimNativeSigning(token,metadata) },
          { deadline -> ApprovalTransport.leases.holdSigning(token,metadata,deadline) },
          { hold -> ApprovalTransport.leases.signingHeld(token,metadata,hold) },
          { hold -> ApprovalTransport.leases.resumeSigning(token,metadata,hold) })
      }
      "upload" -> synchronized(UploadTransport.leases) {
        val row=UploadTransport.leases.signingCapture(token) ?: error("Native upload unavailable")
        val exact=uploadEvent(row.review,unsigned);val registration=JSONObject(row.registration)
        val requester="Napplet: ${registration.getString("appId")}\nPublisher: ${registration.getString("publisher")}\nVersion: ${registration.getString("version")}"
        val expiration=JSONObject(exact).getLong("created_at")+120
        Capture(row.review.identity,exact,requester,listOf(row.review.destination),UploadTransport.leases,
          { UploadTransport.leases.signingCurrent(token,row.marker) && System.currentTimeMillis()/1000<expiration },
          { UploadTransport.leases.claimNativeSigning(token,row.marker) },
          { deadline -> UploadTransport.leases.holdSigning(token,row.marker,deadline) },
          { hold -> UploadTransport.leases.signingHeld(token,row.marker,hold) && System.currentTimeMillis()/1000<expiration },
          { hold -> UploadTransport.leases.resumeSigning(token,row.marker,hold) && System.currentTimeMillis()/1000<expiration })
      }
      "fixture-manifest","fixture-upload" -> synchronized(FixtureReleaseTransport.owner) {
        val owner=FixtureReleaseTransport.owner;val row=owner.current(token) ?: error("Native fixture unavailable")
        if(kind=="fixture-manifest") {
          require(owner.manifestApproved(token) && !row.nativeManifestSigned && row.manifestSnapshot!=null)
          val value=JSONObject(row.manifestSnapshot);require(value.getString("identity")==row.identity)
          val event=value.getJSONObject("event");require(event.getInt("kind")==35129)
          val relays=value.getJSONArray("relays");val destinations=(0 until relays.length()).map { relays.getString(it) }
          destinations.forEach { PublishedRelayWssQuery.parseUrl(NativeOutboxPlan.transportUrl(it)) }
          val exact=JSONObject(NativeOutboxPlan.signingTemplate(event)).put("pubkey",row.identity).toString()
          Capture(row.identity,exact,"Trusted Settings fixture publisher: ${row.fixture}",destinations,owner,
            { owner.current(token)===row && owner.manifestApproved(token) }, { owner.claimNativeSigning(token,row,true) },
            { deadline -> owner.holdSigning(token,row,true,deadline) },
            { hold -> owner.signingHeld(token,row,true,hold) },
            { hold -> owner.resumeSigning(token,row,true,hold) })
        } else {
          require(owner.uploadApproved(token) && !row.nativeUploadSigned)
          val exact=uploadEvent(row.review,unsigned);val expiration=JSONObject(exact).getLong("created_at")+120
          Capture(row.identity,exact,"Trusted Settings fixture upload: ${row.fixture}",listOf(row.review.destination),owner,
            { owner.current(token)===row && owner.uploadApproved(token) && System.currentTimeMillis()/1000<expiration },
            { owner.claimNativeSigning(token,row,false) },
            { deadline -> owner.holdSigning(token,row,false,deadline) },
            { hold -> owner.signingHeld(token,row,false,hold) && System.currentTimeMillis()/1000<expiration },
            { hold -> owner.resumeSigning(token,row,false,hold) && System.currentTimeMillis()/1000<expiration })
        }
      }
      else -> error("Unsupported native signing source")
    }
  }
  private fun uploadEvent(review: NativeUploadAuthority.Review,raw: String): String {
    require(UploadJsonBounds.accepts(raw,4096))
    val event=JSONObject(raw);require(event.keys().asSequence().toSet()==setOf("pubkey","kind","created_at","tags","content"))
    require(event.getString("pubkey")==review.identity && event.getInt("kind")==24242)
    val value=event.get("created_at");require(value is Int || value is Long)
    val created=(value as Number).toLong();val now=System.currentTimeMillis()/1000
    require(created in 1..9_007_199_254_740_871L && created<now && created+120>now)
    val server=java.net.URI(review.destination).host
    val tags=JSONArray().put(JSONArray(listOf("t","upload"))).put(JSONArray(listOf("x",review.sha256)))
      .put(JSONArray(listOf("server",server))).put(JSONArray(listOf("expiration",(created+120).toString())))
    require(event.getJSONArray("tags").toString()==tags.toString() && event.getString("content")=="Upload reviewed file to ${review.destination}")
    return JSONObject().put("pubkey",review.identity).put("kind",24242).put("created_at",created).put("tags",tags)
      .put("content","Upload reviewed file to ${review.destination}").toString()
  }
  @JvmStatic fun cancel(kind: String,token: String) {
    when(kind) {
      "approval" -> ApprovalTransport.cancel(token)
      "upload" -> UploadTransport.cancel(token)
      "fixture-manifest" -> synchronized(FixtureReleaseTransport.owner) { FixtureReleaseTransport.owner.cancel(token, true) }
      "fixture-upload" -> synchronized(FixtureReleaseTransport.owner) { FixtureReleaseTransport.owner.cancel(token, false) }
    }
  }
}
