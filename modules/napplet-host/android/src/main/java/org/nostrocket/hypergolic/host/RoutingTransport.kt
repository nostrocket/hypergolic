package org.nostrocket.hypergolic.host

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/** Native-attested endpoint registration, revision fencing and bounded captured-recipient pushes. */
internal object RoutingTransport {
  private val endpoints = RoutingEndpointRegistry()
  private val main = Handler(Looper.getMainLooper())
  private data class Row(val config: CapabilityConfiguration, var push: ((String) -> Unit)? = null,
    var delivery: Long = 0, var acknowledged: Long = 0, val pending: MutableSet<Long> = mutableSetOf())
  private val rows = mutableMapOf<String, Row>()
  private var sink: ((String) -> Unit)? = null
  @Synchronized fun observeLifecycle(value: ((String) -> Unit)?) { sink = value }
  @Synchronized fun state(): String = JSONObject().put("user", endpoints.user()).put("epoch", endpoints.epoch())
    .put("revision", endpoints.revision()).put("available", endpoints.available()).put("ownerAvailable", endpoints.ownerAvailable()).put("foreground", endpoints.foreground()).toString()
  @Synchronized fun synchronizeOwner(user: String, epoch: Long, available: Boolean): Boolean {
    val before = endpoints.revision()
    if (!endpoints.synchronizeOwner(user, epoch, available)) return false
    if (before != endpoints.revision()) { rows.values.forEach { it.pending.clear() }; sink?.invoke(state()) }
    return true
  }
  @Synchronized fun foreground(value: Boolean) {
    val before = endpoints.revision(); endpoints.foreground(value)
    if (before != endpoints.revision()) { rows.values.forEach { it.pending.clear() }; sink?.invoke(state()) }
  }
  @Synchronized fun register(generation: String, config: CapabilityConfiguration): Boolean {
    if (config.grantedDomains.none { it == "intent" || it == "inc" || it == "notify" || it == "config" }) return true
    if (!endpoints.register(generation, config.user, config.epoch, config.grantedDomains.contains("intent"), config.grantedDomains.contains("inc"), config.grantedDomains.contains("notify"), config.grantedDomains.contains("config"))) return false
    rows[generation] = Row(config); return true
  }
  @Synchronized fun ready(generation: String) { endpoints.ready(generation) }
  @Synchronized fun focus(generation: String, value: Boolean) { if (endpoints.focus(generation, value)) sink?.invoke(state()) }
  @Synchronized fun revoke(generation: String) { endpoints.revoke(generation); rows.remove(generation) }
  @Synchronized fun mayReview(generation: String, revision: Long): Boolean = endpoints.matchesRevision(revision) && endpoints.mayReview(generation)
  @Synchronized fun reviewRevision(generation: String, revision: Long): Long = if (endpoints.matchesRevision(revision)) endpoints.reviewRevision(generation) else -1
  @Synchronized fun mayDeliver(generation: String, revision: Long, domain: String): Boolean =
    endpoints.matchesRevision(revision) && endpoints.mayDeliver(generation, domain) && CapabilityTransport.leases.sessionActive(generation)
  @Synchronized fun receive(generation: String, sequence: Long, raw: String, push: (String) -> Unit, reply: (String?) -> Unit): String? {
    val wrapper = runCatching { UploadWire.objectValue(raw, 36 * 1024, maximumDepth = 40) }.getOrNull()
    val row = rows[generation]
    val id = wrapper?.opt("id") as? String
    val message = wrapper?.opt("message") as? JSONObject
    val type = message?.opt("type") as? String
    val domain = if (type == "notify.__register") "notify" else if (type == "routing.__register") row?.config?.grantedDomains?.firstOrNull { it == "intent" || it == "inc" || it == "notify" || it == "config" } else type?.substringBefore('.')
    val revision = endpoints.revision()
    val valid = row != null && wrapper != null && wrapper.keys().asSequence().toSet() == setOf("type", "id", "message") &&
      wrapper.opt("type") == "routing.call" && id != null && id.matches(Regex("[A-Za-z0-9_-]{1,128}")) && domain != null && mayDeliver(generation, revision, domain) &&
      ((type != "routing.__register" && type != "notify.__register") || message!!.keys().asSequence().toSet() == setOf("type"))
    if (!valid) { CapabilityTransport.leases.consumeSequence(generation, sequence); reply(null); return null }
    row!!.push = push
    wrapper!!.put("revision", revision)
    return CapabilityTransport.admit(generation, sequence, row.config.request(wrapper.toString())) { response ->
      synchronized(this) { reply(if (mayDeliver(generation, revision, domain!!)) response else null) }
    }.also { if (it == null) reply(null) }
  }
  @Synchronized fun send(generation: String, revision: Long, raw: String): Boolean {
    val row = rows[generation] ?: return false
    val message = runCatching { UploadWire.objectValue(raw, 36 * 1024, maximumDepth = 40) }.getOrNull() ?: return false
    val type = message.opt("type") as? String ?: return false
    val domain = type.substringBefore('.')
    if (type !in setOf("intent.changed", "inc.event", "inc.channel.opened", "inc.channel.event", "inc.channel.closed", "notify.action", "notify.clicked", "notify.dismissed", "notify.controls", "config.values", "config.schemaError") ||
      !mayDeliver(generation, revision, domain) || row.push == null || row.pending.size >= 4 || row.delivery >= 9_007_199_254_740_991L) return false
    val delivery = ++row.delivery; row.pending.add(delivery)
    val envelope = JSONObject().put("type", "routing.event").put("sessionId", generation).put("delivery", delivery).put("response", raw).toString()
    main.post { synchronized(this) {
      if (rows[generation] === row && row.pending.contains(delivery) && mayDeliver(generation, revision, domain)) row.push?.invoke(envelope)
      else row.pending.remove(delivery)
    } }
    main.postDelayed({ synchronized(this) { row.pending.remove(delivery) } }, 25_000)
    return true
  }
  @Synchronized fun acknowledge(generation: String, delivery: Long) {
    val row = rows[generation] ?: return
    if (delivery <= row.acknowledged || !row.pending.remove(delivery)) return
    row.acknowledged = delivery
  }
}
