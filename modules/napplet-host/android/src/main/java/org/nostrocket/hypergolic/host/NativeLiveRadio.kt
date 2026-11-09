package org.nostrocket.hypergolic.host

import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.content.res.ColorStateList
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.ScrollView
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
  private var metadata: LinearLayout? = null
  private var actions: LinearLayout? = null
  private var body: ScrollView? = null
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
  private fun dp(value: Int) = (value * host.resources.displayMetrics.density).toInt()
  private fun heading(row: Session) = "Hypergolic · Radio · " + when (row.phase) {
    "playing" -> "Playing"; "buffering" -> "Buffering"; else -> "Paused"
  }
  private fun action(title: String, primary: Boolean) = Button(host.context).apply {
    text = title; isAllCaps = false; textSize = 14f; maxLines = 2
    minimumHeight = dp(48); minimumWidth = 0; minWidth = 0
    setPadding(dp(12), dp(8), dp(12), dp(8))
    setTextColor(if (primary) Color.rgb(24, 17, 11) else Color.rgb(238, 243, 247))
    backgroundTintList = ColorStateList.valueOf(if (primary) Color.rgb(245, 160, 75) else Color.rgb(28, 43, 59))
    filterTouchesWhenObscured = true
  }
  private fun show(row: Session) {
    val controls = LinearLayout(host.context).apply {
      orientation = LinearLayout.VERTICAL; isClickable = true
      setPadding(dp(12), dp(10), dp(12), dp(10))
      background = GradientDrawable().apply { setColor(Color.rgb(17, 29, 41)); setStroke(dp(1).coerceAtLeast(1), Color.rgb(60, 76, 93)) }
    }
    val details = LinearLayout(host.context).apply { orientation = LinearLayout.VERTICAL }
    fun text(value: String, size: Float, color: Int) = TextView(host.context).apply {
      text = value; textSize = size; setTextColor(color)
    }
    val title = text(heading(row), 13f, Color.rgb(245, 160, 75)).apply { setTypeface(typeface, Typeface.BOLD) }
    val source = text(row.url, 13f, Color.rgb(238, 243, 247)).apply {
      contentDescription = "Source: ${row.url}"
    }
    val limits = text("MP3 · 15 minutes / 32 MiB · foreground only", 12f, Color.rgb(175, 189, 203))
    for (view in listOf(title, source, limits)) details.addView(view, LinearLayout.LayoutParams(-1, -2))
    val scroll = ScrollView(host.context).apply { addView(details); isFillViewport = false }
    val buttons = LinearLayout(host.context)
    val start = action("Play radio", true).apply {
      setOnClickListener {
        if (session !== row || !allowed() || permit() == null || panel?.isShown != true) return@setOnClickListener
        if (row.phase == "playing" || row.phase == "buffering") { row.pauseReason = "user"; row.playback.pause() }
        else if (!row.playback.nativePlay()) { title.text = "Hypergolic · Radio\n${MediaPlaybackReservation.hint()}"; layout() }
      }
    }
    val stop = action("Close radio", false).apply {
      setOnClickListener { if (session === row) row.playback.retire("user") }
    }
    buttons.addView(start, LinearLayout.LayoutParams(0, -2, 1f).apply { rightMargin = dp(4) })
    buttons.addView(stop, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(4) })
    controls.addView(scroll, LinearLayout.LayoutParams(-1, 0))
    controls.addView(buttons, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
    host.addView(controls, LinearLayout.LayoutParams(-1, -2))
    panel = controls; label = title; play = start; metadata = details; actions = buttons; body = scroll; layout()
  }
  fun layout() {
    val controls = panel ?: return
    val details = metadata ?: return; val buttons = actions ?: return; val scroll = body ?: return
    val width = host.width - host.paddingLeft - host.paddingRight
    val height = host.height - host.paddingTop - host.paddingBottom
    if (width <= 0 || height <= 0) return
    val innerWidth = (width - controls.paddingLeft - controls.paddingRight).coerceAtLeast(0)
    val exact = View.MeasureSpec.makeMeasureSpec(innerWidth, View.MeasureSpec.EXACTLY)
    val natural = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
    details.measure(exact, natural); buttons.measure(exact, natural)
    val chrome = controls.paddingTop + controls.paddingBottom + dp(6)
    val limit = maxOf((height * 45L / 100).toInt(), buttons.measuredHeight + chrome + dp(32)).coerceAtMost(height)
    val panelHeight = (details.measuredHeight + buttons.measuredHeight + chrome).coerceAtMost(limit)
    val bodyHeight = (panelHeight - buttons.measuredHeight - chrome).coerceAtLeast(0)
    if (scroll.layoutParams.height != bodyHeight) scroll.layoutParams = scroll.layoutParams.apply { this.height = bodyHeight }
    controls.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(panelHeight, View.MeasureSpec.EXACTLY))
    val top = host.height - host.paddingBottom - panelHeight
    controls.layout(host.paddingLeft, top, host.paddingLeft + width, top + panelHeight)
  }
  private fun handle(row: Session, value: String) {
    if (session !== row || disposed) return
    if (value.startsWith("ended:")) {
      val reason = value.removePrefix("ended:")
      row.push(JSONObject().put("type", "media.session.ended").put("sessionId", row.id).put("reason", reason))
      panel?.let(host::removeView); panel = null; label = null; play = null; metadata = null; actions = null; body = null; session = null; return
    }
    if (value == "focus-lost") { row.pauseReason = "focus-lost"; return }
    row.phase = value
    play?.text = if (value == "playing" || value == "buffering") "Pause radio" else "Play radio"
    label?.text = heading(row)
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
  fun dispose() { retire(); disposed = true; instances.remove(generation); panel?.let(host::removeView); panel = null; metadata = null; actions = null; body = null }
  companion object {
    private val instances = mutableMapOf<String, WeakReference<NativeLiveRadio>>()
    fun revokeGenerations(generations: Set<String>) { generations.forEach { instances[it]?.get()?.retire("policy") } }
  }
}
