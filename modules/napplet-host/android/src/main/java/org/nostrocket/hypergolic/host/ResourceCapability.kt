package org.nostrocket.hypergolic.host

import org.json.JSONObject

/** Permission comes only from the claimed native snapshot, never Expo arguments or a resource payload. */
internal object ResourceCapability {
  fun admission(token: String): String? {
    val snapshot = CapabilityTransport.leases.borrowedSnapshot(token) ?: return null
    return try {
      val value = JSONObject(snapshot)
      val registration = value.getJSONObject("registration")
      val domains = registration.getJSONArray("domains")
      if (!(0 until domains.length()).any { domains.get(it) == "resource" }) return null
      val request = JSONObject(value.getString("request"))
      if (request.optString("type") !in setOf("resource.bytes", "resource.bytesMany")) return null
      registration.getString("generation").takeIf { CapabilityTransport.leases.isActive(token) }
    } catch (_: Exception) { null }
  }
}
