package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONObject

internal fun PublishedArtifactRegistry.Snapshot.toWire(): JSONObject =
  JSONObject().put("kind", 5129).put("eventId", eventId).put("title", title)

internal fun parseSnapshotMetadata(fields: JSONObject): PublishedArtifactRegistry.Snapshot? {
  if (fields.keys().asSequence().toSet() != setOf("kind", "eventId", "title") || fields.get("kind") != 5129) return null
  return PublishedArtifactRegistry.Snapshot.create(
    fields.get("eventId") as? String ?: return null, fields.get("title") as? String ?: return null)
}

internal fun signingRequester(registration: JSONObject): String {
  val publisher = registration.getString("publisher")
  val app = registration.getString("appId")
  val label = if (registration.has("snapshot")) {
    val snapshot = parseSnapshotMetadata(registration.getJSONObject("snapshot")) ?: error("Invalid snapshot registration")
    require(snapshot.appKey() == app)
    snapshot.requester(publisher)
  } else {
    require(!app.startsWith(" 5129:"))
    "Napplet: $app\nPublisher: $publisher"
  }
  return "$label\nVersion: ${registration.getString("version")}"
}

/** First immutable source/destination capture. This is correlation metadata, never user consent. */
internal class NativeApprovalSigningData private constructor(val source: String,val user: String,val template: String,
  val requester: String,val destinations: List<String>,val eventId: String) {
  fun unsigned(): String=JSONObject(template).put("pubkey",user).toString()
  companion object {
    fun capture(source: String,raw: String,plan: Any?): NativeApprovalSigningData {
      require(UploadJsonBounds.accepts(raw,NativeApprovalAuthority.MAX_BYTES+4096))
      val original=JSONObject(source);val registration=original.getJSONObject("registration");val request=JSONObject(original.getString("request"))
      val user=registration.getString("user");require(user.matches(Regex("[0-9a-f]{64}")))
      val type = request.getString("type")
      val common = type in NativeCommonPlan.operations
      val grant = when (type) {
        "relay.publish" -> "relay"
        "outbox.publish" -> "outbox"
        else -> if (common) "common" else error("Invalid publication")
      }
      val domains = registration.getJSONArray("domains")
      require((0 until domains.length()).any { domains.getString(it) == grant })
      val snapshot=JSONObject(raw);require(snapshot.keys().asSequence().toSet()==setOf("event","selectedPubkey","destinations","hash"))
      require(snapshot.getString("selectedPubkey")==user)
      val event=snapshot.getJSONObject("event");val expectedEvent = if(common) {
        require(NativeCommonPlan.granted(registration) && plan is NativeCommonPlan);plan.template ?: error("No-op cannot sign")
      } else request.getJSONObject("event")
      val template=NativeOutboxPlan.signingTemplate(expectedEvent)
      require(NativeOutboxPlan.signingTemplate(event)==template)
      require(event.getInt("kind")!=22242 && event.getInt("kind")!=24242)
      val eventId=NativeOutboxPlan.signingHash(event,user);require(snapshot.getString("hash")==eventId)
      val rows=snapshot.getJSONArray("destinations");require(rows.length() in 1..16)
      val destinations=(0 until rows.length()).map { rows.get(it) as? String ?: error("Invalid destination") }
      require(destinations.distinct().size==destinations.size)
      destinations.forEach { PublishedRelayWssQuery.parseUrl(NativeOutboxPlan.transportUrl(it)) }
      if(common)require(plan is NativeCommonPlan && plan.matches(event,user,destinations,eventId))
      if(type=="outbox.publish" || NativeAppDataPolicy.claims(request))require(plan is NativeOutboxPlan && plan.matchesSigning(event,user,destinations,eventId))
      val requester = signingRequester(registration) + "\nSession: ${registration.getString("sessionId")}\nEpoch: ${registration.getLong("epoch")}"
      return NativeApprovalSigningData(source,user,template,requester,destinations.toList(),eventId)
    }
  }
}
