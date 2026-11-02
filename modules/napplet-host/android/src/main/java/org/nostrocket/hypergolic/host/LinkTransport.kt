package org.nostrocket.hypergolic.host

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject

/** Native review and one-shot OS handoff; no guest-visible generic opening API. */
internal object LinkTransport {
  private val leases = LinkLeaseRegistry(SystemClock::elapsedRealtime)
  private val main = Handler(Looper.getMainLooper())
  private data class Pending(val generation: String, val id: String, val url: String, val reply: (String?) -> Unit, var dialog: AlertDialog? = null)
  private val pending = mutableMapOf<String, Pending>()
  fun register(generation: String, config: CapabilityConfiguration) = leases.register(generation, config.user, config.epoch)
  fun synchronizeOwner(user: String, epoch: Long, available: Boolean): Boolean {
    val tokens = leases.synchronizeOwner(user, epoch, available) ?: return false
    main.post { cancel(tokens, true) }; return true
  }
  fun focus(generation: String, value: Boolean) { cancel(leases.focus(generation, value), false) }
  fun foreground(value: Boolean) { val tokens = leases.foreground(value); main.post { cancel(tokens, false) } }
  fun revoke(generation: String) { cancel(leases.revoke(generation), true) }
  private fun result(id: String, status: String, error: String? = null): String = JSONObject().put("type", "link.open.result")
    .put("id", id).put("status", status).apply { if (error != null) put("error", error) }.toString()
  private fun cancel(tokens: List<String>, revoked: Boolean) {
    for (token in tokens) pending.remove(token)?.let { p -> p.dialog?.dismiss(); p.reply(if (revoked || !leases.canDeliver(p.generation)) null else result(p.id, "denied", "blocked-by-policy")) }
  }
  private fun finish(token: String, status: String, error: String? = null) {
    val active = leases.finish(token)
    pending.remove(token)?.let { p -> p.dialog?.dismiss(); p.reply(if (active) result(p.id, status, error) else if (leases.canDeliver(p.generation)) result(p.id, "denied", "blocked-by-policy") else null) }
  }
  fun receive(generation: String, config: CapabilityConfiguration, raw: String, activity: Activity?, reply: (String?) -> Unit) {
    check(Looper.myLooper() == Looper.getMainLooper())
    if (!leases.canDeliver(generation)) { reply(null); return }
    val value = runCatching { UploadWire.objectValue(raw, 16 * 1024) }.getOrNull() ?: run { reply(null); return }
    val id = value.opt("id") as? String
    if (id == null || id.isEmpty() || id.toByteArray().size > 128 || id.any { it.code < 32 || it.code == 127 }) { reply(null); return }
    val url = value.opt("url") as? String
    val options = value.opt("options")
    val shape = value.keys().asSequence().all { it in setOf("type", "id", "url", "options") } && value.opt("type") == "link.open" &&
      (!value.has("options") || options is JSONObject && options.keys().asSequence().all { it == "label" } &&
        (!options.has("label") || options.opt("label") is String && options.getString("label").toByteArray().size <= 256 && options.getString("label").none { it.code < 32 || it.code == 127 }))
    val error = if (!shape) "invalid-url" else LinkUrl.error(url)
    if (error != null) { reply(result(id, "denied", error)); return }
    val token = if (config.grantedDomains.contains("link") && activity != null && !activity.isFinishing && !activity.isDestroyed) leases.admit(generation) else null
    if (token == null) { reply(result(id, "denied", "blocked-by-policy")); return }
    val p = Pending(generation, id, url!!, reply); pending[token] = p
    val author = if (config.fixture == "published") "Publisher: ${config.publisher}" else "Unsigned embedded test napplet"
    p.dialog = AlertDialog.Builder(activity).setTitle("Open external link?")
      .setMessage("Napplet: ${LinkUrl.displayIdentity(config.appId)}\n$author\n\nDestination: ${Uri.parse(url).host}\n$url\n\nYour device may open a browser or an associated app.")
      .setNegativeButton("Cancel") { _, _ -> finish(token, "denied", "user-denied") }
      .setPositiveButton("Open once") { _, _ -> dispatch(token, activity!!) }
      .setOnCancelListener { finish(token, "denied", "user-denied") }.create()
    runCatching { p.dialog!!.show() }.onFailure { finish(token, "denied", "blocked-by-policy") }
    main.postDelayed({ cancel(leases.expire(), false) }, 25_000)
  }
  private fun dispatch(token: String, activity: Activity) {
    val p = pending[token] ?: return
    if (!leases.claim(token)) { finish(token, "denied", "blocked-by-policy"); return }
    try {
      activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(p.url)).addCategory(Intent.CATEGORY_BROWSABLE))
      finish(token, "opened")
    } catch (_: Exception) { finish(token, "denied", "blocked-by-policy") }
  }
}
