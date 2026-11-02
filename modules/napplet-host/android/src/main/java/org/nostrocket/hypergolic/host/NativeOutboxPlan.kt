package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Immutable app-only review capture. App Schnorr verification is still mandatory. */
internal class NativeOutboxPlan private constructor(
  val requestId: String, private val template: String, private val identity: String,
  private val hash: String, val destinations: List<String>, private val ancillary: String?
) {
  private val consumed = mutableSetOf<String>()
  private var primary: String? = null
  private var deadline: Long? = null
  fun reserve(group: String, wire: String, relay: String, now: Long): Send {
    require(relay in destinations && group in listOf("primary", "relay-list"))
    require(UploadJsonBounds.accepts(wire, NativeApprovalAuthority.MAX_BYTES))
    val signed = signed(JSONObject(wire), identity)
    if (group == "primary") {
      val event = JSONObject(wire)
      require(unsigned(event) == template && event.getString("id") == hash)
      require(primary == null || primary == signed)
      primary = signed
    } else require(ancillary != null && signed == ancillary && primary != null)
    require(consumed.add("$group\n$relay")) { "Publication pair already consumed" }
    if (deadline == null) deadline = now + 15_000
    return Send(relay, JSONObject(wire).getString("id"), "[\"EVENT\",$signed]", deadline!!)
  }
  internal fun matchesSigning(event: JSONObject,user: String,relays: List<String>,eventId: String): Boolean =
    identity==user && template==unsigned(event,true) && destinations==relays && hash==eventId
  class Send(val relay: String, val eventId: String, val frame: String, val deadline: Long) {
    @Volatile var attempted = false
  }
  companion object {
    internal fun signingTemplate(event: JSONObject): String = unsigned(event,true)
    internal fun signingHash(event: JSONObject,user: String): String = eventHash(event,user)
    fun transportUrl(relay: String): String = if (java.net.URI(relay).rawPath == "/") relay.dropLast(1) else relay
    fun capture(snapshot: String, raw: String): NativeOutboxPlan {
      require(UploadJsonBounds.accepts(raw, NativeApprovalAuthority.MAX_BYTES))
      val envelope = JSONObject(snapshot)
      val registration = envelope.getJSONObject("registration")
      val request = JSONObject(envelope.getString("request"))
      val identity = registration.getString("user")
      require(identity.matches(Regex("[0-9a-f]{64}")))
      val domains = strings(registration.getJSONArray("domains"))
      require("outbox" in domains && "relay" in domains && request.getString("type") == "outbox.publish")
      val plan = JSONObject(raw)
      fields(plan, setOf("requestId", "event", "destinations", "requiredInboxes", "ownSource", "ancillary"))
      val event = plan.getJSONObject("event")
      fields(event, setOf("event", "selectedPubkey", "destinations", "hash"))
      require(plan.getString("requestId") == request.getString("id") && event.getString("selectedPubkey") == identity)
      val template = unsigned(request.getJSONObject("event"), true)
      require(unsigned(event.getJSONObject("event"), true) == template)
      val kind = request.getJSONObject("event").getInt("kind")
      require(kind != 22242 && kind != 24242)
      val hash = eventHash(event.getJSONObject("event"), identity)
      require(event.getString("hash") == hash)
      val dummy = JSONObject(template).put("id", hash).put("pubkey", identity).put("sig", "0".repeat(128))
      require(("[\"EVENT\"," + signed(dummy, identity) + "]").toByteArray(Charsets.UTF_8).size <= PublishedRelayWebSocketClientFrames.MAX_TEXT_BYTES)
      val destinations = strings(event.getJSONArray("destinations"))
      require(destinations.size in 1..16 && destinations.toSet().size == destinations.size)
      for (relay in destinations) PublishedRelayWssQuery.parseUrl(transportUrl(relay))
      val reviewed = plan.getJSONArray("destinations")
      require(reviewed.length() == destinations.size)
      for (index in destinations.indices) require(reviewed.getJSONObject(index).getString("relay") == destinations[index])
      require(strings(plan.getJSONArray("requiredInboxes")).all { it in destinations })
      val options = request.optJSONObject("options")
      val skipped = options?.opt("toOutbox") == false
      require(!skipped || plan.getString("ownSource") == "skipped")
      val ancillary = if (plan.isNull("ancillary")) null else signed(plan.getJSONObject("ancillary"), identity).also {
        require(!skipped && plan.getJSONObject("ancillary").getInt("kind") == 10002)
      }
      require(ancillary == null || ("[\"EVENT\",$ancillary]").toByteArray(Charsets.UTF_8).size <= PublishedRelayWebSocketClientFrames.MAX_TEXT_BYTES)
      return NativeOutboxPlan(plan.getString("requestId"), template, identity, hash, destinations.toList(), ancillary)
    }
    private fun fields(value: JSONObject, expected: Set<String>) { require(value.keys().asSequence().toSet() == expected) }
    private fun string(value: JSONObject, key: String): String = value.get(key) as? String ?: error("Invalid string")
    private fun integer(value: Any, max: Long): Long {
      require(value is Int || value is Long)
      return (value as Number).toLong().also { require(it in 0..max) }
    }
    private fun strings(value: JSONArray): List<String> = (0 until value.length()).map { value.get(it) as? String ?: error("Invalid string") }
    private fun tags(value: JSONArray): String = (0 until value.length()).joinToString(",", "[", "]") {
      val row = strings(value.getJSONArray(it)); require(row.isNotEmpty()); row.joinToString(",", "[", "]", transform = ::quote)
    }
    private fun unsigned(value: JSONObject, strict: Boolean = false): String {
      if (strict) fields(value, setOf("kind", "created_at", "tags", "content"))
      val kind = integer(value.get("kind"), 65535); val created = integer(value.get("created_at"), 9_007_199_254_740_991L)
      return "{\"kind\":$kind,\"content\":${quote(string(value, "content"))},\"tags\":${tags(value.getJSONArray("tags"))},\"created_at\":$created}"
    }
    private fun eventHash(value: JSONObject, identity: String): String {
      val canonical = "[0,${quote(identity)},${integer(value.get("created_at"), 9_007_199_254_740_991L)},${integer(value.get("kind"), 65535)},${tags(value.getJSONArray("tags"))},${quote(string(value, "content"))}]"
      return MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    private fun signed(value: JSONObject, identity: String): String {
      fields(value, setOf("id", "pubkey", "created_at", "kind", "tags", "content", "sig"))
      require(string(value, "pubkey") == identity && string(value, "sig").matches(Regex("[0-9a-f]{128}")))
      val hash = eventHash(value, identity); require(string(value, "id") == hash)
      val event = JSONObject(unsigned(value))
      return "{\"id\":${quote(hash)},\"pubkey\":${quote(identity)},\"created_at\":${event.getLong("created_at")},\"kind\":${event.getInt("kind")},\"tags\":${tags(event.getJSONArray("tags"))},\"content\":${quote(event.getString("content"))},\"sig\":${quote(string(value, "sig"))}}"
    }
    private fun quote(value: String): String = buildString {
      append('"')
      var index = 0
      while (index < value.length) {
        val character = value[index++]
        when (character) {
          '"' -> append("\\\"")
          '\\' -> append("\\\\")
          '\b' -> append("\\b")
          '\u000c' -> append("\\f")
          '\n' -> append("\\n")
          '\r' -> append("\\r")
          '\t' -> append("\\t")
          else -> if (character.code < 32) append("\\u%04x".format(character.code)) else {
            if (Character.isHighSurrogate(character)) { require(index < value.length && Character.isLowSurrogate(value[index])); append(character); append(value[index++]) }
            else { require(!Character.isLowSurrogate(character)); append(character) }
          }
        }
      }
      append('"')
    }
  }
}
