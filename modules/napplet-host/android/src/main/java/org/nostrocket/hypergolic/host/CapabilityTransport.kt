package org.nostrocket.hypergolic.host

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject

/** Registry methods run synchronously on the calling thread. Reply closures stay on the UI thread. */
internal object CapabilityTransport {
  val leases = CapabilityLeaseRegistry(SystemClock::elapsedRealtime)
  private val main = Handler(Looper.getMainLooper())
  private data class Pending(val generation: String, val access: IdentityListAccess.Ticket?, val reply: (String?) -> Unit)
  private val pending = mutableMapOf<String, Pending>()

  fun admit(generation: String, sequence: Long, snapshot: String, reply: (String?) -> Unit): String? {
    check(Looper.myLooper() == Looper.getMainLooper())
    val token = leases.admit(generation, sequence, snapshot) ?: return null
    val access = runCatching { IdentityListAccess.capture(snapshot) }.getOrElse { leases.finish(token); return null }
    pending[token] = Pending(generation, access, reply)
    main.postDelayed({
      // The registry's elapsedRealtime deadline is authoritative, including device sleep.
      if (!leases.isActive(token)) pending.remove(token)?.reply?.invoke(null)
    }, 25_000)
    return token
  }
  fun finish(token: String, response: String?) {
    val bounded = response?.takeIf { it.toByteArray(Charsets.UTF_8).size <= CapabilityLeaseRegistry.MAX_BYTES }
    main.post {
      val admitted = leases.finish(token)
      val request = pending.remove(token) ?: return@post
      request.reply(if (admitted && leases.sessionActive(request.generation) && IdentityListAccess.permits(request.access)) bounded else null)
    }
  }
  fun foreground(value: Boolean) {
    RoutingTransport.foreground(value)
    LinkTransport.foreground(value)
    val revoked = leases.setForeground(value)
    main.post { for (token in revoked) pending.remove(token)?.reply?.invoke(null) }
  }
  fun revoke(generation: String) {
    // Revoke before dispatching callbacks, navigating or dismantling a renderer.
    RoutingTransport.revoke(generation)
    leases.revoke(generation)
    ResourceHttpsRequestOwner.INSTANCE.revokeGeneration(generation)
    RelaySubscriptionTransport.revoke(generation)
    check(Looper.myLooper() == Looper.getMainLooper())
    val tokens = pending.filterValues { it.generation == generation }.keys.toList()
    for (token in tokens) pending.remove(token)?.reply?.invoke(null)
  }
}
