package org.nostrocket.hypergolic.host

import org.json.JSONObject

/** Permission comes only from the claimed native snapshot, never Expo arguments or a resource payload. */
internal object ResourceCapability {
  fun admission(token: String, url: String): String? {
    val snapshot = CapabilityTransport.leases.borrowedSnapshot(token) ?: return null
    return try {
      val value = JSONObject(snapshot)
      val registration = value.getJSONObject("registration")
      val domains = registration.getJSONArray("domains")
      val request = JSONObject(value.getString("request"))
      val resource = (0 until domains.length()).any { domains.get(it) == "resource" } &&
        request.optString("type") in setOf("resource.bytes", "resource.bytesMany")
      if (!resource && !LegacyReadOnlyContext.permitsImage(snapshot, url)) return null
      registration.getString("generation").takeIf { CapabilityTransport.leases.isActive(token) }
    } catch (_: Exception) { null }
  }
}
