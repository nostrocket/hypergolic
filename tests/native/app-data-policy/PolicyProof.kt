package org.nostrocket.hypergolic.host

import java.io.File
import org.json.JSONObject

internal object PolicyProof {
  @JvmStatic fun main(args: Array<String>) {
    val input = JSONObject(File(args[0]).readText())
    val rows = input.getJSONArray("cases")
    val message = input.getString("request")
    var accepted = 0
    for (index in 0 until rows.length()) {
      val row = rows.getJSONObject(index)
      val name = row.getString("name")
      val parsed = runCatching { CapabilityConfiguration(row.getString("raw"), "generation-a", true) }.getOrNull()
      check((parsed != null) == row.getBoolean("ok")) { "Configuration outcome: $name" }
      if (parsed == null) continue
      accepted++
      val original = row.getJSONObject("configuration")
      val snapshot = JSONObject(parsed.snapshot)
      check(snapshot.getString("generation") == "generation-a") { "Native generation: $name" }
      check(parsed.grantedDomains.toSet() == (0 until original.getJSONArray("domains").length()).map { original.getJSONArray("domains").getString(it) }.toSet())
      check(parsed.allowsRelayOperation("relay.publish") == parsed.grantedDomains.contains("relay"))
      check(parsed.allowsRelayOperation("outbox.publish") == parsed.grantedDomains.contains("outbox"))
      val metadata = NativeChunkProjection.project(parsed, "generation-a")
      check(metadata.getString("sessionId") == "generation-a")
      if (original.has("appData")) {
        val expected = original.getJSONObject("appData")
        check(JSONObject(parsed.appData!!).similar(expected)) { "Captured policy: $name" }
        check(snapshot.getJSONObject("appData").similar(expected)) { "Policy snapshot: $name" }
        check(metadata.getJSONObject("appData").similar(expected)) { "Guest metadata: $name" }
      } else {
        check(parsed.appData == null && !snapshot.has("appData") && !metadata.has("appData"))
      }
      val envelope = JSONObject(parsed.request(message))
      check(envelope.getString("request").toByteArray().contentEquals(message.toByteArray())) { "Opaque request changed: $name" }
      check(envelope.getJSONObject("registration").similar(snapshot)) { "Registration changed: $name" }
      val next = CapabilityConfiguration(row.getString("raw"), "generation-b", true)
      check(JSONObject(next.snapshot).getString("generation") == "generation-b")
      check(JSONObject(parsed.snapshot).getString("generation") == "generation-a")
      check(NativeChunkProjection.project(next, "generation-b").getString("sessionId") == "generation-b")
      original.put("appData", JSONObject().put("forged", true))
      check(JSONObject(parsed.snapshot).similar(snapshot)) { "Mutable caller changed captured config: $name" }
    }
    println("Android app-data policy: ${rows.length()} cases passed; $accepted configuration/request/metadata roundtrips")
  }
}
