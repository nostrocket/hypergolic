package org.nostrocket.hypergolic.host

import org.json.JSONObject

/** Trusted React Native configuration. No field is accepted from a napplet request. */
internal class CapabilityConfiguration(raw: String, generation: String, allowPublished: Boolean = false) {
  val snapshot: String
  val sessionId: String
  val fixture: String
  val allowsUpload: Boolean
  val user: String
  val epoch: Long
  val allowsRelay: Boolean
  val publisher: String
  val appId: String
  val version: String
  val grantedDomains: List<String>
  init {
    require(raw.toByteArray(Charsets.UTF_8).size <= 8192)
    val value = JSONObject(raw)
    val names = setOf("sessionId", "epoch", "user", "publisher", "appId", "version", "instanceId", "fixture", "domains")
    require(value.keys().asSequence().toSet() == names)
    fun string(name: String): String = (value.get(name) as? String) ?: error("Invalid configuration")
    for (name in listOf("sessionId", "instanceId", "fixture")) require(string(name).matches(Regex("[A-Za-z0-9_-]{1,80}")))
    for (name in listOf("user", "publisher", "version")) require(string(name).matches(Regex("[0-9a-f]{64}")))
    require(string("appId").toByteArray(Charsets.UTF_8).size in 1..1024)
    val epoch = value.get("epoch")
    require((epoch is Int || epoch is Long) && (epoch as Number).toLong() in 0..9_007_199_254_740_991L)
    val domains = value.getJSONArray("domains")
    val granted = (0 until domains.length()).map { domains.get(it) as? String ?: error("Invalid domain") }
    require(granted.size == granted.toSet().size)
    fixture = string("fixture")
    val expected = when (fixture) {
      "ux-lab", "close-lab" -> setOf("theme")
      "state-lab", "state-lab-peer" -> setOf("identity", "storage", "theme")
      "approval-lab", "approval-lab-v1", "approval-lab-v2", "approval-lab-v3" -> setOf("identity", "relay", "theme")
      "upload-lab", "upload-queue-lab" -> setOf("upload", "theme")
      "resource-lab" -> setOf("resource", "link", "theme")
      "nap-support" -> setOf("link", "theme")
      "routing-lab", "routing-lab-peer" -> setOf("intent", "inc", "notify", "config", "theme")
      "feed-lab-v1" -> setOf("identity", "outbox", "relay", "theme")
      "feed-lab" -> if ("outbox" in granted) setOf("identity", "outbox", "relay", "theme") else setOf("identity", "relay", "theme")
      "published" -> {
        require(allowPublished)
        require(PublishedCapabilityBinding.validDomains(granted))
        granted.toSet()
      }
      else -> error("Unknown bundled fixture")
    }
    if (fixture != "published") require(granted.toSet() == expected)
    user = string("user")
    this.epoch = (epoch as Number).toLong()
    allowsUpload = "upload" in granted
    allowsRelay = "relay" in granted
    grantedDomains = granted.sorted()
    sessionId = string("sessionId")
    publisher = string("publisher")
    appId = string("appId")
    version = string("version")
    value.put("generation", generation)
    snapshot = value.toString()
  }
  fun request(message: String): String = JSONObject().put("registration", JSONObject(snapshot))
    .put("request", message).toString()
}
