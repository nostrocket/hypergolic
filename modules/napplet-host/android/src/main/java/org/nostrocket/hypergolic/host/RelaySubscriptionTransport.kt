package org.nostrocket.hypergolic.host

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject

/** Captured native recipient; four unacknowledged pushes bound each stream's renderer queue. */
internal object RelaySubscriptionTransport {
  val registry = RelaySubscriptionRegistry(SystemClock::elapsedRealtime, CapabilityTransport.leases::sessionActive)
  private val main = Handler(Looper.getMainLooper())
  private data class Row(val generation: String, val sequence: Long, val subId: String,
    val push: (String) -> Unit, val outbox: Boolean, var delivery: Long = 0, var acknowledged: Long = 0,
    val sizes: MutableMap<Long, Int> = mutableMapOf(),
    val payloads: MutableMap<Long, String> = mutableMapOf(), val pushed: MutableSet<Long> = mutableSetOf(), var terminal: Boolean = false)
  private val rows = mutableMapOf<String, Row>()
  private var foreground = false
  private var revision = 0L
  private var lifecycleSink: ((String) -> Unit)? = null
  @Synchronized fun observeLifecycle(sink: ((String) -> Unit)?) { lifecycleSink = sink }
  @Synchronized fun lifecycle(): String = JSONObject().put("active", foreground).put("revision", revision).toString()
  @Synchronized fun admit(generation: String, sequence: Long, snapshot: String, subId: String,
    push: (String) -> Unit, outbox: Boolean = false): String? {
    val token = registry.admit(generation, snapshot, outbox) ?: return null
    rows[token] = Row(generation, sequence, subId, push, outbox)
    main.postDelayed({ synchronized(this) { if (!registry.isActive(token)) close(token) } }, 25_000)
    return token
  }
  @Synchronized fun hasCapacity(token: String): Boolean = registry.mayDeliver(token) && (rows[token]?.sizes?.size ?: 4) < 4
  @Synchronized fun send(token: String, response: String): Int {
    val row = rows[token] ?: return -1
    if (registry.isActive(token) && !registry.mayDeliver(token)) return 0
    val bytes = response.toByteArray(Charsets.UTF_8).size
    if (!registry.mayDeliver(token) || row.terminal || bytes > 66 * 1024 ||
      row.sizes.size >= 4 || row.sizes.values.sum() + bytes > 256 * 1024) { close(token); return -1 }
    val message = runCatching { JSONObject(response) }.getOrNull() ?: run { close(token); return -1 }
    if (message.opt("subId") != row.subId || message.optString("type") !in (if (row.outbox) setOf("outbox.event", "relay.eose", "outbox.closed") else setOf("relay.event", "relay.eose", "relay.closed"))) {
      close(token); return -1
    }
    val delivery = ++row.delivery
    row.sizes[delivery] = bytes
    row.terminal = message.optString("type") == (if (row.outbox) "outbox.closed" else "relay.closed")
    val envelope = JSONObject().put("type", "capability.stream").put("sessionId", row.generation)
      .put("sequence", row.sequence).put("delivery", delivery).put("response", response).toString()
    row.payloads[delivery] = envelope
    dispatch(token, row, delivery)
    main.postDelayed({ synchronized(this) { if (rows[token] === row && registry.mayDeliver(token) && row.sizes.containsKey(delivery)) close(token) } }, 25_000)
    return 1
  }
  @Synchronized fun acknowledge(generation: String, streamSequence: Long, delivery: Long) {
    val entry = rows.entries.firstOrNull { it.value.generation == generation && it.value.sequence == streamSequence } ?: return
    val row = entry.value
    if (!registry.isActive(entry.key) || delivery != row.acknowledged + 1 || row.sizes.remove(delivery) == null) { close(entry.key); return }
    row.acknowledged = delivery; row.payloads.remove(delivery); row.pushed.remove(delivery)
    if (row.terminal && row.sizes.isEmpty()) close(entry.key)
  }
  @Synchronized fun close(token: String) { registry.close(token); rows.remove(token); RelayStreamWssOwner.cancelToken(token) }
  @Synchronized fun revoke(generation: String) { rows.filterValues { it.generation == generation }.keys.toList().forEach(::close); registry.revoke(generation) }
  private fun dispatch(token: String, row: Row, delivery: Long) {
    main.post {
      synchronized(this) {
        if (rows[token] === row && registry.mayDeliver(token) && row.sizes.containsKey(delivery) && row.pushed.add(delivery)) {
          try { row.push(row.payloads[delivery] ?: return@synchronized) } catch (_: Exception) { close(token) }
        }
      }
    }
  }
  @Synchronized fun foreground(active: Boolean) {
    if (foreground == active) return
    foreground = active; revision++
    registry.setForeground(active)
    RelayStreamWssOwner.setForeground(active)
    for ((token, row) in rows) {
      val control = JSONObject().put("type", "capability.stream-control").put("sessionId", row.generation)
        .put("sequence", row.sequence).put("active", active).put("revision", revision).toString()
      main.post { synchronized(this) { if (rows[token] === row && registry.isActive(token)) row.push(control) } }
      if (active) row.payloads.keys.sorted().forEach { dispatch(token, row, it) }
    }
    lifecycleSink?.invoke(lifecycle())
  }
  @Synchronized fun revokeAll() { registry.revokeAll(); rows.clear(); RelayStreamWssOwner.revokeAll() }
}
