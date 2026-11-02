package org.nostrocket.hypergolic.host

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject

/** Native admission is independent of React Native delivery and timers. Replies remain on the main thread. */
internal object ApprovalTransport {
  val leases = ApprovalLeaseRegistry(SystemClock::elapsedRealtime)
  private val main = Handler(Looper.getMainLooper())
  private data class Pending(val generation: String, val id: String, val resultType: String, val reply: (String?) -> Unit)
  private val pending = mutableMapOf<String, Pending>()

  fun register(generation: String): Boolean = leases.register(generation)
  fun foreground(active: Boolean) { leases.foreground(active); main.post { sweep() } }
  fun focus(generation: String, active: Boolean) { leases.focus(generation, active); main.post { sweep() } }
  fun resume() { leases.resume(); main.post { sweep() } }

  fun admit(generation: String, snapshot: String, id: String, reply: (String?) -> Unit): String? {
    check(Looper.myLooper() == Looper.getMainLooper())
    sweep()
    val outbox = runCatching { JSONObject(JSONObject(snapshot).getString("request")).getString("type") == "outbox.publish" }.getOrDefault(false)
    val token = leases.admit(generation, snapshot, outbox) ?: return null
    pending[token] = Pending(generation, id, if (outbox) "outbox.publish.result" else "relay.publish.result", reply)
    main.postDelayed({ sweep() }, NativeApprovalAuthority.LIFETIME_MS)
    return token
  }
  fun prepareOutbox(token: String, raw: String): Boolean = runCatching {
    synchronized(leases) {
      val snapshot = leases.claimedSnapshot(token) ?: return false
      leases.prepare(token, NativeOutboxPlan.capture(snapshot, raw))
    }
  }.getOrDefault(false)
  fun failOutbox(token: String, error: String) {
    val captured = error.takeIf { it.toByteArray(Charsets.UTF_8).size in 1..4096 } ?: "approval denied"
    leases.cancel(token)
    main.post {
      val row = pending[token]
      if (row?.resultType == "outbox.publish.result") deliver(token, JSONObject().put("type", row.resultType)
        .put("id", row.id).put("ok", false).put("error", captured).toString())
      else deliver(token, null)
    }
  }
  fun dismiss(token: String) {
    leases.dismiss(token)
    leases.cancel(token) // Even a stale dismiss is terminal for its exact token.
    main.post { deliver(token, null) }
  }
  fun cancel(token: String) {
    leases.cancel(token) // Revoke authority before queueing any UI/effect cleanup.
    main.post { deliver(token, null) }
  }
  fun finish(token: String, response: String?) {
    val bounded = response?.takeIf { it.toByteArray(Charsets.UTF_8).size <= NativeApprovalAuthority.MAX_BYTES }
    main.post {
      val approved = leases.finish(token)
      deliver(token, if (approved) bounded else null)
      sweep()
    }
  }
  fun revoke(generation: String) {
    leases.revoke(generation)
    if (Looper.myLooper() == Looper.getMainLooper()) sweep() else main.post { sweep() }
  }
  private fun sweep() {
    check(Looper.myLooper() == Looper.getMainLooper())
    for (token in leases.drainInvalid()) deliver(token, null)
  }
  private fun deliver(token: String, response: String?) {
    val request = pending.remove(token) ?: return
    if (!CapabilityTransport.leases.sessionActive(request.generation)) { request.reply(null); return }
    val exact = runCatching {
      val parsed = JSONObject(response ?: error("Denied"))
      require(parsed.optString("type") == request.resultType && parsed.optString("id") == request.id)
      require(parsed.get("ok") is Boolean)
      response
    }.getOrNull()
    request.reply(exact ?: JSONObject().put("type", request.resultType).put("id", request.id)
      .put("ok", false).put("error", "approval denied").toString())
  }
}
