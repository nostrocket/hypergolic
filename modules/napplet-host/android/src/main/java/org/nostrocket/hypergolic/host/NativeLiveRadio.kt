package org.nostrocket.hypergolic.host

import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.UUID

/** Trusted foreground source card. The guest can offer it; only its native Play button starts bytes/output. */
internal class NativeLiveRadio(private val host: LinearLayout, private val generation: String,
  private val profile: () -> String?, private val scope: () -> String?, private val permit: () -> String?, private val allowed: () -> Boolean) {
  private class Session(val id: String, val url: String, val push: (JSONObject) -> Unit) {
    lateinit var playback: LiveMP3Playback
    var phase = "paused"
    var pauseReason = "user"
  }
  private var session: Session? = null
  private var panel: LinearLayout? = null
  private var label: TextView? = null
  private var play: Button? = null
  private var created = 0
  private var disposed = false
  init { instances[generation] = WeakReference(this) }
  fun hasSession() = session != null
  fun ownsSession(value: String?) = value != null && session?.id == value
  fun receive(request: JSONObject, push: (JSONObject) -> Unit) {
    if (request.opt("type") == "media.session.create") { create(request, push); return }
    val row = session ?: return
    if (request.opt("sessionId") != row.id) return
    val names = request.keys().asSequence().toSet()
    if (request.opt("type") == "media.session.destroy" && names == setOf("type", "sessionId")) { row.playback.retire("destroyed"); return }
    if (!allowed() || permit() == null || request.opt("type") != "media.command" || names != setOf("type", "sessionId", "action")) return
    when (request.opt("action")) {
      "pause" -> { row.pauseReason = "user"; row.playback.pause() }
      "stop" -> row.playback.retire("user")
      // Play from the publisher cannot create or resume a network connection. Native Play remains required.
      "play" -> Unit
    }
  }
  private fun create(request: JSONObject, push: (JSONObject) -> Unit) {
    val id = (request.opt("id") as? String)?.takeIf { it.matches(Regex("[!-~]{1,128}")) } ?: return
    val result = JSONObject().put("type", "media.session.create.result").put("id", id)
    fun reject(message: String) = push(result.put("error", message))
    if (profile() != LiveMP3Owner.PROFILE) { reject("Live radio needs renewed Media access. Close this napplet and reopen it from Discover."); return }
    if (disposed || !allowed() || permit() == null || scope() == null || created >= 64) { reject("Media is unavailable while this napplet is not active."); return }
    if (session != null) { reject("Close the radio player before creating another source."); return }
    val url = request.opt("url") as? String
    if (request.keys().asSequence().toSet() != setOf("type", "id", "url", "live") || request.opt("live") != true || url == null ||
      runCatching { PublishedHttpsTransport.validateRequest(url, PublishedHttpsRequestOwner.addressPolicy()) }.isFailure) { reject("Unsupported radio source."); return }
    val row = Session("media-" + UUID.randomUUID(), url, push)
    row.playback = LiveMP3Playback(host.context, url, profile(), scope()!!, permit) { value -> handle(row, value) }
    session = row; created++; show(row)
    push(result.put("sessionId", row.id).put("owner", "shell")); state(row); capabilities(row)
  }
  private fun show(row: Session) {
    val controls = LinearLayout(host.context).apply { orientation = LinearLayout.VERTICAL }
    val title = TextView(host.context).apply { text = "${row.url}\nMP3 radio · 15 minutes / 32 MiB · foreground only"; maxLines = 4 }
    val actions = LinearLayout(host.context)
    val start = Button(host.context).apply { text = "Play radio"; filterTouchesWhenObscured = true
      setOnClickListener {
        if (session !== row || !allowed() || permit() == null || panel?.isShown != true) return@setOnClickListener
        if (row.phase == "playing" || row.phase == "buffering") { row.pauseReason = "user"; row.playback.pause() }
        else if (!row.playback.nativePlay()) title.text = MediaPlaybackReservation.hint()
      }
    }
    val stop = Button(host.context).apply { text = "Close radio"; filterTouchesWhenObscured = true
      setOnClickListener { if (session === row) row.playback.retire("user") }
    }
    actions.addView(start); actions.addView(stop); controls.addView(title); controls.addView(actions)
    host.addView(controls, LinearLayout.LayoutParams(-1, -2)); panel = controls; label = title; play = start; layout()
  }
  fun layout() {
    val controls = panel ?: return
    if (host.width <= 0 || host.height <= 0) return
    controls.measure(View.MeasureSpec.makeMeasureSpec(host.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(host.height, View.MeasureSpec.AT_MOST))
    controls.layout(0, host.height - controls.measuredHeight, host.width, host.height)
  }
  private fun handle(row: Session, value: String) {
    if (session !== row || disposed) return
    if (value.startsWith("ended:")) {
      val reason = value.removePrefix("ended:")
      row.push(JSONObject().put("type", "media.session.ended").put("sessionId", row.id).put("reason", reason))
      panel?.let(host::removeView); panel = null; label = null; play = null; session = null; return
    }
    if (value == "focus-lost") { row.pauseReason = "focus-lost"; return }
    row.phase = value
    play?.text = if (value == "playing" || value == "buffering") "Pause radio" else "Play radio"
    label?.text = "${row.url}\nMP3 radio · 15 minutes / 32 MiB · $value"
    state(row); capabilities(row); layout()
  }
  private fun state(row: Session) {
    val event = JSONObject().put("type", "media.state").put("sessionId", row.id).put("status", row.phase)
    if (row.phase == "paused") event.put("reason", row.pauseReason)
    row.push(event)
  }
  private fun capabilities(row: Session) {
    val actions = if (row.phase == "playing" || row.phase == "buffering") listOf("play", "pause", "stop") else listOf("pause", "stop")
    row.push(JSONObject().put("type", "media.capabilities").put("sessionId", row.id).put("actions", JSONArray(actions)))
  }
  fun focusChanged() {
    val row = session ?: return
    panel?.visibility = if (allowed()) View.VISIBLE else View.INVISIBLE
    if (!allowed()) { row.pauseReason = "focus-lost"; row.playback.pause() }
  }
  fun retire(reason: String = "policy") { session?.playback?.retire(reason) }
  fun dispose() { retire(); disposed = true; instances.remove(generation); panel?.let(host::removeView); panel = null }
  companion object {
    private val instances = mutableMapOf<String, WeakReference<NativeLiveRadio>>()
    fun revokeGenerations(generations: Set<String>) { generations.forEach { instances[it]?.get()?.retire("policy") } }
  }
}
