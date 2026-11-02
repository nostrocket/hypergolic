package org.nostrocket.hypergolic.host

import android.content.Context
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Packaged code only: no file picker, caller-supplied HTML or generic guest upload path. */
internal object FixtureReleaseTransport {
  internal val owner = FixtureReleaseAuthority(SystemClock::elapsedRealtime)
  fun synchronize(user: String, epoch: Long, available: Boolean) { require(owner.synchronize(user, epoch, available)) }
  fun foreground(active: Boolean) = owner.foreground(active)
  fun cancel() = owner.cancel()
  fun prepare(context: Context, fixture: String, server: String): String {
    val catalog = context.assets.open("runtime/fixture-release.json").use { input ->
      val output=ByteArrayOutputStream();val chunk=ByteArray(8192)
      while(true) {val read=input.read(chunk);if(read<0)break;require(output.size()+read<=1024*1024);output.write(chunk,0,read)}
      output.toByteArray()
    }
    require(catalog.size <= 1024 * 1024)
    val artifacts = JSONObject(String(catalog, Charsets.UTF_8)).getJSONObject("artifacts")
    require(artifacts.has(fixture))
    val artifact = artifacts.getJSONObject(fixture)
    val html = artifact.getString("html").toByteArray(Charsets.UTF_8)
    val hash = artifact.getString("sha256")
    require(FixtureReleaseAuthority.hash((hash + " /index.html\n").toByteArray(Charsets.UTF_8)) == artifact.getString("aggregate"))
    val tags = artifact.getJSONArray("tags")
    require(tags.getJSONArray(0).getString(0) == "d" && tags.getJSONArray(0).getString(1) == fixture)
    val row = owner.prepare(fixture, html, hash, server, tags.toString()) ?: error("Fixture release inactive")
    return JSONObject().put("token", row.token).put("fixture", row.fixture).put("identity", row.identity).put("server",row.server)
      .put("sha256",row.review.sha256).put("size",row.review.size).put("html",String(html,Charsets.UTF_8)).put("tags",tags).toString()
  }
  fun approveUpload(token: String) = owner.approveUpload(token)
  fun uploadApproved(token: String) = owner.uploadApproved(token)
  fun manifestApproved(token: String) = owner.manifestApproved(token)
  fun prepareManifest(token: String, relays: List<String>): String {
    val row = owner.current(token) ?: error("Fixture release revoked")
    require(relays.size in 1..8 && relays.distinct().size == relays.size && relays.all { it.startsWith("wss://") && it.length <= 2048 })
    val tags = JSONArray(row.manifestTags).put(JSONArray(listOf("server",row.server)))
    val template = JSONObject().put("kind",35129).put("created_at",System.currentTimeMillis()/1000).put("content","").put("tags",tags)
    val snapshot = JSONObject().put("identity",row.identity).put("relays",JSONArray(relays)).put("event",template).toString()
    require(owner.prepareManifest(token,snapshot));return snapshot
  }
  fun approveManifest(token: String): String? = owner.approveManifest(token)
  fun put(token: String, credential: String): String {
    val row = owner.current(token) ?: return "{\"ok\":false,\"error\":\"policy denied\"}"
    val grant = row.grant ?: return "{\"ok\":false,\"error\":\"policy denied\"}"
    val permit = NativeBlossomPermit.capture(row.review,credential,System.currentTimeMillis()/1000)
      ?: return "{\"ok\":false,\"error\":\"policy denied\"}"
    if(!owner.uploadApproved(token)) return "{\"ok\":false,\"error\":\"policy denied\"}"
    val registration = JSONObject().put("user",row.identity).put("publisher",row.identity).put("appId",row.fixture).toString()
    val transfer = UploadLeaseRegistry.Transfer(owner.uploads,grant,permit,registration,UUID.randomUUID().toString())
    val result = JSONObject(UploadTransport.putTrustedFixture(transfer))
    if(!result.optBoolean("ok"))return result.toString()
    return try {
      val bytes = PublishedHttpsRequestOwner.INSTANCE.fetch(UUID.randomUUID().toString(),row.server + "/" + row.review.sha256) { owner.uploadApproved(token) }
      require(owner.verifyRetrieved(token,bytes))
      result.put("retrievedSha256",FixtureReleaseAuthority.hash(bytes)).put("retrievedSize",bytes.size).toString()
    } catch (_: Exception) { JSONObject().put("ok",false).put("error","upload accepted; payload retrieval unverified").toString() }
  }
}
