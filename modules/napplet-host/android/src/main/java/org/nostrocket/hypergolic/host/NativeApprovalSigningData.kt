package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONObject

/** First immutable source/destination capture. This is correlation metadata, never user consent. */
internal class NativeApprovalSigningData private constructor(val source: String,val user: String,val template: String,
  val requester: String,val destinations: List<String>,val eventId: String) {
  fun unsigned(): String=JSONObject(template).put("pubkey",user).toString()
  companion object {
    fun capture(source: String,raw: String,plan: Any?): NativeApprovalSigningData {
      require(UploadJsonBounds.accepts(raw,NativeApprovalAuthority.MAX_BYTES+4096))
      val original=JSONObject(source);val registration=original.getJSONObject("registration");val request=JSONObject(original.getString("request"))
      val user=registration.getString("user");require(user.matches(Regex("[0-9a-f]{64}")))
      val domains=registration.getJSONArray("domains");require((0 until domains.length()).any { domains.getString(it)=="relay" })
      val type=request.getString("type");require(type=="relay.publish" || type=="outbox.publish")
      val snapshot=JSONObject(raw);require(snapshot.keys().asSequence().toSet()==setOf("event","selectedPubkey","destinations","hash"))
      require(snapshot.getString("selectedPubkey")==user)
      val event=snapshot.getJSONObject("event");val template=NativeOutboxPlan.signingTemplate(request.getJSONObject("event"))
      require(NativeOutboxPlan.signingTemplate(event)==template)
      require(event.getInt("kind")!=22242 && event.getInt("kind")!=24242)
      val eventId=NativeOutboxPlan.signingHash(event,user);require(snapshot.getString("hash")==eventId)
      val rows=snapshot.getJSONArray("destinations");require(rows.length() in 1..16)
      val destinations=(0 until rows.length()).map { rows.get(it) as? String ?: error("Invalid destination") }
      require(destinations.distinct().size==destinations.size)
      destinations.forEach { PublishedRelayWssQuery.parseUrl(NativeOutboxPlan.transportUrl(it)) }
      if(type=="outbox.publish")require(plan is NativeOutboxPlan && plan.matchesSigning(event,user,destinations,eventId))
      val requester="Napplet: ${registration.getString("appId")}\nPublisher: ${registration.getString("publisher")}\nVersion: ${registration.getString("version")}\nSession: ${registration.getString("sessionId")}\nEpoch: ${registration.getLong("epoch")}"
      return NativeApprovalSigningData(source,user,template,requester,destinations.toList(),eventId)
    }
  }
}
