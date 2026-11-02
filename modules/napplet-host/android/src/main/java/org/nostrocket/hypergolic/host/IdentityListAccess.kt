package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONObject

internal object IdentityListAccess {
  data class Ticket(val owner: IdentityListAccessRegistry.Owner, val epoch: Long)
  fun replace(raw: String) {
    try {
      require(UploadJsonBounds.accepts(raw, 140000))
      val rows = JSONArray(raw)
      require(rows.length() <= 64)
      val owners = (0 until rows.length()).map { index ->
        val row = rows.getJSONObject(index)
        require(row.keys().asSequence().toSet() == setOf("user", "publisher", "appId"))
        IdentityListAccessRegistry.Owner(row.get("user") as String, row.get("publisher") as String, row.get("appId") as String)
      }
      IdentityListAccessRegistry.INSTANCE.replace(owners)
    } catch (error: Exception) {IdentityListAccessRegistry.INSTANCE.clear(); throw error}
  }
  fun capture(snapshot: String): Ticket? {
    val data = UploadWire.objectValue(snapshot, CapabilityLeaseRegistry.MAX_BYTES)
    val request = UploadWire.objectValue(data.getString("request"), CapabilityLeaseRegistry.MAX_BYTES, maximumDepth = 40)
    require(request.optString("type") == "routing.call" || UploadJsonBounds.accepts(data.getString("request"), CapabilityLeaseRegistry.MAX_BYTES))
    if (request.optString("type") !in setOf("identity.getMutes", "identity.getList")) return null
    val owner = data.getJSONObject("registration")
    return Ticket(IdentityListAccessRegistry.Owner(owner.getString("user"), owner.getString("publisher"), owner.getString("appId")), IdentityListAccessRegistry.INSTANCE.capture())
  }
  fun permits(ticket: Ticket?): Boolean = ticket == null || IdentityListAccessRegistry.INSTANCE.permits(ticket.owner, ticket.epoch)
}
