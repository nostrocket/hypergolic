package org.nostrocket.hypergolic.host

import org.json.JSONObject
import java.net.URI

/** Public policy metadata from trusted configuration. It is never a signing or transport grant. */
internal object NativeAppDataPolicy {
  fun claims(request: JSONObject): Boolean {
    val event = request.optJSONObject("event") ?: return false
    if (!event.has("tags")) return false
    val tags = event.optJSONArray("tags") ?: return true
    if (tags.length() > 8192) return true
    return (0 until tags.length()).any { index ->
      val row = tags.optJSONArray(index) ?: return@any true
      if (row.length() == 0) return@any true
      val name = row.opt(0) as? String; val value = row.opt(1) as? String
      (name == "d" && (value == "soy.app-data/1" || value?.startsWith("soy.app-data/1:") == true)) ||
        (name in listOf("L", "l") && (0 until row.length()).any { row.opt(it) == "soy.app-data/1" })
    }
  }
  /** Reuses only the private publication carrier; an actual Relay grant remains required. */
  fun rawRelay(registration: JSONObject, request: JSONObject): Boolean = runCatching {
    require(request.getString("type") == "relay.publish" && claims(request))
    val domains = registration.getJSONArray("domains")
    require((0 until domains.length()).any { domains.get(it) == "relay" })
    validatePublication(registration, request, emptyList()); true
  }.getOrDefault(false)
  fun validatePublication(registration: JSONObject, request: JSONObject, destinations: List<String>) {
    val domains = registration.getJSONArray("domains")
    val grants = (0 until domains.length()).map { domains.getString(it) }
    val context = JSONObject(capture(registration.get("appData"), registration.getString("publisher"),
      registration.getString("appId"), registration.getString("fixture"), grants))
    val policy = context.getJSONObject("policy"); val scope = policy.getString("scope")
    val event = request.getJSONObject("event"); require(event.get("kind") == 30078)
    require(event.getString("content").toByteArray(Charsets.UTF_8).size <= 3072)
    val tags = event.getJSONArray("tags")
    val identifiers = (0 until tags.length()).map { tags.getJSONArray(it) }.filter { it.opt(0) == "d" }
    require(identifiers.size == 1 && identifiers[0].length() == 2 &&
      identifiers[0].getString(1).startsWith("soy.app-data/1:$scope:"))
    val peers = policy.getJSONArray("relays")
    val allowed = (0 until peers.length()).map { URI(peers.getString(it)).normalize() }
    require(destinations.size <= 8 && destinations.all { target ->
      val normalized = if (URI(target).rawPath == "/") target.dropLast(1) else target
      URI(normalized).normalize() in allowed
    })
  }
  fun capture(value: Any, publisher: String, appId: String, fixture: String, domains: List<String>): String {
    require(fixture == "published" && "identity" in domains && domains.any { it == "outbox" || it == "relay" })
    val context = value as? JSONObject ?: error("Invalid app-data context")
    require(context.keys().asSequence().toSet() == setOf("sourceKind", "policy"))
    val kind = context.get("sourceKind")
    require((kind is Int || kind is Long) && (kind as Number).toLong() == 35129L)
    val policy = context.getJSONObject("policy")
    require(policy.keys().asSequence().toSet() == setOf("profile", "scope", "maxContentBytes", "relays", "defaultRelays"))
    require(policy.get("profile") == "soy.app-data/1")
    require(policy.get("scope") == NativeCanonicalJSON.hashStrings(listOf("soy.app-data/1", "$publisher:35129:$appId")))
    val maximum = policy.get("maxContentBytes")
    require((maximum is Int || maximum is Long) && (maximum as Number).toLong() == 3072L)
    val relays = policy.getJSONArray("relays")
    require(relays.length() in 1..8)
    val peers = (0 until relays.length()).map { index ->
      val peer = relays.get(index) as? String ?: error("Invalid app-data peer")
      require(peer.toByteArray(Charsets.UTF_8).size in 1..256 && peer.all { it.code in 33..126 } && '\\' !in peer)
      val url = URI(peer)
      require(url.scheme == "wss" && !url.host.isNullOrEmpty() && url.host.contains('.') &&
        url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null && (url.port == -1 || url.port in 1..65535))
      peer
    }
    require(peers.distinct().size == peers.size)
    val defaults = policy.getJSONArray("defaultRelays")
    require(defaults.length() == 1 && defaults.get(0) == peers[0])
    return context.toString().also { require(it.toByteArray(Charsets.UTF_8).size <= 3072) }
  }
}
