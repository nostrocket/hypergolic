package org.nostrocket.hypergolic.host

import org.json.JSONObject

internal object OutboxQueryCapability {
  fun admits(leases: CapabilityLeaseRegistry, token: String): Boolean {
    val snapshot = leases.borrowedSnapshot(token) ?: return false
    return try {
      val value = JSONObject(snapshot)
      val domains = value.getJSONObject("registration").getJSONArray("domains")
      val request = JSONObject(value.getString("request"))
      request.optString("type") in setOf("outbox.query", "outbox.getEvent") &&
        (0 until domains.length()).any { domains.get(it) == "outbox" } && leases.isActive(token)
    } catch (_: Exception) { false }
  }
}
