package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONObject

/** Explicit native authority for historical zero-domain releases. Never a Relay or Identity grant. */
internal class LegacyReadOnlyContext(value: JSONObject, publisher: String, appId: String, version: String,
  fixture: String, domains: List<String>) {
  val metadata: String
  val eventId: String
  val htmlHash: String
  private val relays: Set<String>
  init {
    require(fixture == "published" && domains.isEmpty())
    require(value.keys().asSequence().toSet() == setOf("profile", "consent", "eventId", "htmlHash", "relays"))
    require(value.opt("profile") == "legacy-read-only-v1" && value.opt("consent") == true)
    eventId = value.getString("eventId"); htmlHash = value.getString("htmlHash")
    require(publisher == "c2f1ab4e6a577dd8980b57e15986ed92830b95a94f374192235563532b5cac20")
    val expected = when(appId) {
      "recipe-cards" -> listOf("b70911af4382baded327ce6af4b595197ff7a4781e3704b9f066a74f68b48a07", "92d5639e1da2a0b9ac6bbb9d41d67b0026c15ed614e2d553f8ad2e4e4e896ecc", "9067048a9ce80d7e79ea76b960acc88aa53645754ec4e7549de1c1525a690194")
      "longform" -> listOf("5fff2ec459ffb1a2d2966fc9815bc8ba45db96a669dfe4924d6c63e65b08a24e", "3ba5049444dd249abbe671f818d555b4e3c90b7cab88a70187bc3a012f9afd67", "d5558df7e1f3823c0ad5c64273d57802fe304c1e2266bab8e5151fbf05ad51f4")
      else -> error("Unsupported legacy release")
    }
    require(listOf(eventId, version, htmlHash) == expected)
    val urls = value.getJSONArray("relays")
    require(urls.length() in 1..16)
    val captured = (0 until urls.length()).map { urls.get(it) as? String ?: error("Invalid relay") }
    captured.forEach { require(it.toByteArray(Charsets.UTF_8).size <= 2048); require(relayURL(it)) }
    require(captured.toSet().size == captured.size)
    relays = captured.toSet(); metadata = value.toString()
  }
  fun matches(event: String, hash: String) = event == eventId && hash == htmlHash
  fun allowsClose(request: JSONObject): Boolean = request.keys().asSequence().toSet() == setOf("type", "id", "subId") &&
    request.opt("type") == "legacy.close" && identifier(request.opt("id")) && identifier(request.opt("subId"))
  fun allowsSubscribe(request: JSONObject): Boolean = runCatching {
    require(request.keys().asSequence().toSet() == setOf("type", "id", "subId", "filters", "relay"))
    require(request.opt("type") == "legacy.subscribe" && identifier(request.opt("id")) && identifier(request.opt("subId")))
    require(request.opt("relay") in relays)
    validateFilters(request.getJSONArray("filters")); true
  }.getOrDefault(false)
  /** Initial relay history never expands the established 32-event/64-frame budget. */
  class HistoryBudget {
    private var events = 0
    private var frames = 0
    private var ended = false
    fun receive(text: String): Boolean = runCatching {
      if(ended) return true
      require(++frames <= 64)
      val frame = JSONArray(text)
      when(frame.opt(0)) {
        "EVENT" -> require(++events <= 32)
        "EOSE" -> ended = true
      }
      true
    }.getOrDefault(false)
  }
  companion object {
    private fun identifier(value: Any?): Boolean = value is String && value.toByteArray(Charsets.UTF_8).size in 1..128 && value.none { it.code < 32 || it.code == 127 }
    private fun relayURL(raw: String): Boolean = runCatching {
      require(raw.none { it.code <= 32 || it.code >= 127 || it == '\\' })
      val uri = java.net.URI(raw); val host = uri.host ?: return false
      require(uri.scheme == "wss" && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
      require(host == host.lowercase() && host.length <= 253 && (uri.port == -1 || uri.port in 1..65535) && uri.port != 443)
      val labels = host.split(".")
      require(labels.size >= 2 && labels.all { it.length <= 63 && it.matches(Regex("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?")) } && !labels.last().matches(Regex("[0-9]+")))
      require(listOf("localhost", "local", "localdomain", "lan", "internal", "home", "home.arpa", "test", "example", "invalid", "onion", "arpa").none { host == it || host.endsWith(".$it") })
      val path = uri.rawPath ?: ""
      require(path != "/" && path.split("/").none { it == "." || it == ".." } && !path.lowercase().contains("%0d") && !path.lowercase().contains("%0a"))
      require(raw == "wss://" + host + (if(uri.port == -1) "" else ":" + uri.port) + path); true
    }.getOrDefault(false)
    private fun integer(value: Any?): Long? = if (value is Int || value is Long) (value as Number).toLong().takeIf { it in 0..9_007_199_254_740_991L } else null
    private fun validateFilters(filters: JSONArray) {
      require(filters.length() in 1..4)
      for(i in 0 until filters.length()) {
        val filter = filters.getJSONObject(i); require(filter.length() <= 32)
        require(integer(filter.opt("limit"))?.let { it <= 32 } == true)
        for(key in filter.keys()) {
          val value = filter.get(key)
          if(key in setOf("limit", "since", "until")) require(integer(value) != null)
          else {
            require(key in setOf("ids", "authors", "kinds") || key.matches(Regex("#[a-zA-Z]")))
            val list = value as? JSONArray ?: error("Invalid filter"); require(list.length() in 1..64)
            for(j in 0 until list.length()) {
              val item = list.get(j)
              if(key == "kinds") require(integer(item)?.let { it <= 65535 && it != 4L && it != 1059L } == true)
              else { require(item is String && item.toByteArray(Charsets.UTF_8).size <= 1024)
                if(key in setOf("ids", "authors", "#e", "#p")) require(item.matches(Regex("[0-9a-f]{64}"))) }
            }
          }
        }
        if(filter.has("since") && filter.has("until")) require(integer(filter.get("since"))!! <= integer(filter.get("until"))!!)
      }
    }
    /** Native effect boundary: destinations and the complete REQ filter payload remain captured. */
    fun permitsWire(snapshot: String?, url: String, wire: String, subId: String): Boolean = runCatching {
      val row = JSONObject(snapshot ?: return false)
      val registration = row.getJSONObject("registration")
      if(!registration.has("legacyReadOnly")) return true
      val context = LegacyReadOnlyContext(registration.getJSONObject("legacyReadOnly"), registration.getString("publisher"), registration.getString("appId"), registration.getString("version"), registration.getString("fixture"), emptyList())
      require(registration.getJSONArray("domains").length() == 0)
      val request = JSONObject(row.getString("request")); require(context.allowsSubscribe(request) && request.getString("relay") == url)
      val frame = JSONArray(wire); require(frame.length() == request.getJSONArray("filters").length() + 2 && frame.get(0) == "REQ" && frame.get(1) == subId)
      val filters = JSONArray(); for(i in 2 until frame.length()) filters.put(frame.get(i))
      require(jsonEqual(filters, request.getJSONArray("filters"))); true
    }.getOrDefault(false)
    private fun jsonEqual(left: Any?, right: Any?): Boolean = when {
      left is JSONObject && right is JSONObject -> left.keys().asSequence().toSet() == right.keys().asSequence().toSet() && left.keys().asSequence().all { jsonEqual(left.get(it), right.get(it)) }
      left is JSONArray && right is JSONArray -> left.length() == right.length() && (0 until left.length()).all { jsonEqual(left.get(it), right.get(it)) }
      else -> left == right
    }
  }
}
