package org.nostrocket.hypergolic.host

import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/** Registry methods run synchronously on the calling thread. Reply closures stay on the UI thread. */
internal object CapabilityTransport {
  val leases = CapabilityLeaseRegistry(SystemClock::elapsedRealtime)
  private val main = Handler(Looper.getMainLooper())
  private data class Pending(val generation: String, val access: IdentityListAccess.Ticket?, val reply: (String?) -> Unit,
    var dispatch: ((String) -> Unit)? = null)
  private val pending = mutableMapOf<String, Pending>()

  fun admit(generation: String, sequence: Long, snapshot: String, reply: (String?) -> Unit): String? =
    admit(generation, sequence, snapshot, false, reply)

  fun admitPublishedOpen(generation: String, sequence: Long, snapshot: String, reply: (String?) -> Unit): String? =
    admit(generation, sequence, snapshot, true, reply)

  fun enqueue(generation: String, sequence: Long, snapshot: String, reply: (String?) -> Unit, dispatch: (String) -> Unit) {
    check(Looper.myLooper() == Looper.getMainLooper())
    val token = leases.enqueue(generation, sequence, snapshot) ?: run { reply(null); return }
    remember(token, Pending(generation, null, reply, dispatch), 25_000)
    drain()
  }

  private fun drain() {
    for (token in leases.promote()) {
      val request = pending[token] ?: continue
      val dispatch = request.dispatch ?: continue
      request.dispatch = null
      if (leases.retained(token)) dispatch(token)
    }
  }

  private fun admit(generation: String, sequence: Long, snapshot: String, publishedOpen: Boolean, reply: (String?) -> Unit): String? {
    check(Looper.myLooper() == Looper.getMainLooper())
    val token = (if (publishedOpen) leases.admitPublishedOpen(generation, sequence, snapshot) else leases.admit(generation, sequence, snapshot)) ?: return null
    val access = runCatching { IdentityListAccess.capture(snapshot) }.getOrElse { leases.finish(token); drain(); return null }
    remember(token, Pending(generation, access, reply), if (publishedOpen) 120_000 else 25_000)
    return token
  }
  private fun remember(token: String, request: Pending, lifetimeMs: Long) {
    pending[token] = request
    main.postDelayed({
      // The registry's elapsedRealtime deadline is authoritative, including device sleep.
      if (!leases.retained(token)) pending.remove(token)?.reply?.invoke(null)
      drain()
    }, lifetimeMs)
  }
  fun finish(token: String, response: String?) {
    val bounded = response?.takeIf { it.toByteArray(Charsets.UTF_8).size <= CapabilityLeaseRegistry.MAX_BYTES }
    main.post {
      val admitted = leases.finish(token)
      val request = pending.remove(token)
      if (request != null) request.reply(if (admitted && leases.sessionActive(request.generation) && IdentityListAccess.permits(request.access)) bounded else null)
      drain()
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
    drain()
  }
}
