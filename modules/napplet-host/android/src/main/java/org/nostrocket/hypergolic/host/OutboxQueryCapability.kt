package org.nostrocket.hypergolic.host

import org.json.JSONObject

internal object OutboxQueryCapability {
  fun admits(leases: CapabilityLeaseRegistry, token: String): Boolean {
    val snapshot = leases.borrowedSnapshot(token) ?: return false
    return try {
      val value = JSONObject(snapshot)
      val domains = value.getJSONObject("registration").getJSONArray("domains")
      val request = JSONObject(value.getString("request"))
      val grants = (0 until domains.length()).map { domains.get(it) }
      val type = request.optString("type")
      val operation = type in setOf("outbox.query", "outbox.getEvent") ||
        type == "common.getProfile" && "common" in grants
      operation && "outbox" in grants && leases.isActive(token)
    } catch (_: Exception) { false }
  }
}
