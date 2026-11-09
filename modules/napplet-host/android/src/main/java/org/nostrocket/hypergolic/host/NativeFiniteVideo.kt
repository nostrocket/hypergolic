package org.nostrocket.hypergolic.host

import android.content.Context
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Main-thread player owner. A publisher can request a card; only the card can start its fetch. */
internal class NativeFiniteVideo(private val host: LinearLayout, private val generation: String,
  private val permit: () -> String?, private val allowed: () -> Boolean) {
  private class Session(val id: String, val url: String, val hostName: String, val push: (JSONObject) -> Unit) {
    var consent: String? = null
    var networkActive = false
    var retired = false
    var reserved = false
    var releaseUncertain = false
    var started = false
    var volume = 1f
    var file: File? = null
    var view: SurfaceView? = null
    var videoSize: FiniteVideoSize? = null
    var prepared = false
    var decoderReady = false
    var finished = false
    var player: MediaPlayer? = null
    var fetching: Fetch? = null
    var focus: AudioManager.OnAudioFocusChangeListener? = null
    var focusRevision = 0
  }
  private class Fetch {
    val deadline = PublishedHttpsTransport.Deadline.afterMillis(MediaHttpsFile.TOTAL_MS.toLong())
    val progressPending = AtomicBoolean()
    @Volatile var cancelled = false
  }
  private var session: Session? = null
  private var created = 0
  private var panel: LinearLayout? = null
  private var label: TextView? = null
  private var playButton: Button? = null
  private var stopButton: Button? = null
  private val main = Handler(Looper.getMainLooper())
  private val audio = host.context.getSystemService(Context.AUDIO_SERVICE) as AudioManager


  fun hasSession() = session != null
  fun receive(request: JSONObject, push: (JSONObject) -> Unit) {
    if (request.opt("type") == "media.session.create") { create(request, push); return }
    val row = session ?: return
    if (request.opt("sessionId") != row.id) return
    val fields = request.keys().asSequence().toSet()
    if (request.opt("type") == "media.session.destroy" && fields == setOf("type", "sessionId")) {
      retire("destroyed"); return
    }
    if (!allowed() || permit() == null || request.opt("type") != "media.command" || fields.any { it !in commandFields }) return
    val action = request.opt("action") as? String ?: return
    val value = (request.opt("value") as? Number)?.toDouble()?.takeIf { it.isFinite() }
    if (request.has("value") != (action == "seek" || action == "volume")) return
    when (action) {
      "play" -> if (authorized(row) && row.prepared) resume(row)
      "pause" -> pause(row, "user")
      "stop" -> retire("user")
      "seek" -> if (value != null && value in 0.0..3600.0) row.player?.let {
        if (row.prepared && authorized(row)) it.seekTo((value * 1000).toInt().coerceAtMost(it.duration.coerceAtLeast(0)))
      }
      "volume" -> if (value != null && value in 0.0..1.0) {
        row.volume = value.toFloat(); if (row.prepared) row.player?.setVolume(row.volume, row.volume)
        state(row, status(row))
      }
    }
  }

  private fun create(request: JSONObject, push: (JSONObject) -> Unit) {
    val id = (request.opt("id") as? String)?.takeIf { it.matches(requestId) } ?: return
    val result = JSONObject().put("type", "media.session.create.result").put("id", id)
    fun reject(reason: String) = push(result.put("error", reason))
    if (!allowed() || permit() == null || created >= 64) { reject("Media unavailable."); return }
    val url = (request.opt("url") as? String)?.takeIf { it.toByteArray(Charsets.UTF_8).size in 1..8192 }
    val target = try { url?.let { PublishedHttpsTransport.validateRequest(it, PublishedHttpsRequestOwner.addressPolicy()) } }
      catch (_: Exception) { null }
    if (request.keys().asSequence().toSet() != createFields || target == null || url == null ||
        target.path.endsWith(".m3u8", ignoreCase = true)) { reject("Unsupported media source."); return }
    active?.retire("preempted")
    val row = Session("media-" + UUID.randomUUID(), url, target.host, push)
    session = row; active = this; created++
    show(row)
    push(result.put("sessionId", row.id).put("owner", "shell"))
    state(row, "paused")
    capabilities(row)
  }

  private fun show(row: Session) {
    val controls = LinearLayout(host.context).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.BLACK) }
    val heading = TextView(host.context).apply { text = offer(row); setTextColor(Color.WHITE); maxLines = 3 }
    val actions = LinearLayout(host.context)
    val play = Button(host.context).apply { text = "Play video"; filterTouchesWhenObscured = true; setOnClickListener { trustedPlay(row) } }
    val stop = Button(host.context).apply { text = "Close video"; filterTouchesWhenObscured = true; setOnClickListener { if (session === row) retire("user") } }
    actions.addView(play); actions.addView(stop)
    controls.addView(heading); controls.addView(actions)
    host.addView(controls, LinearLayout.LayoutParams(-1, -2))
    panel = controls; label = heading; playButton = play; stopButton = stop
    layout()
  }

  fun layout() {
    val controls = panel ?: return
    if (host.width <= 0 || host.height <= 0) return
    session?.let { row ->
      val size = row.videoSize?.fit(host.width, (host.height * 55L / 100).toInt()) ?: FiniteVideoSize(1, 1)
      row.view?.let { video ->
        val params = video.layoutParams
        if (params.width != size.width || params.height != size.height) {
          params.width = size.width; params.height = size.height
          video.layoutParams = params
        }
      }
    }
    controls.measure(View.MeasureSpec.makeMeasureSpec(host.width, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(host.height, View.MeasureSpec.AT_MOST))
    controls.layout(0, host.height - controls.measuredHeight, host.width, host.height)
  }

  private fun trustedPlay(row: Session) {
    if (session !== row || !allowed() || panel?.isShown != true) return
    if (row.started) { row.consent = null; pause(row, "user"); return }
    if (row.fetching != null) return
    val receipt = permit() ?: return
    if (!MediaPlaybackReservation.acquire(row)) { label?.text = MediaPlaybackReservation.hint(); return }
    row.reserved = true
    row.consent = receipt
    row.file?.let { file ->
      if (row.prepared) resume(row)
      else row.view?.holder?.takeIf { it.surface.isValid }?.let { prepare(row, it, file) }
      return
    }
    if (downloading) { label?.text = "Previous video is stopping. Try Play again."; return }
    val fetch = Fetch()
    row.fetching = fetch; downloading = true; row.networkActive = true
    val directory = File(host.context.cacheDir, "hypergolic-finite-media-file-v1")
    state(row, "buffering")
    label?.text = "${row.hostName} · Connecting"
    playButton?.isEnabled = false; stopButton?.text = "Cancel download"
    worker.execute {
      val cancelled = PublishedHttpsTransport.Cancellation { fetch.cancelled || permit() != receipt }
      val file = stage(row, fetch, directory, cancelled)
      main.post { row.networkActive = false; releaseReservation(row); complete(row, fetch, file) }
    }
  }

  private fun offer(row: Session) = "${row.hostName} · Play downloads up to 256 MiB"

  private fun stage(row: Session, fetch: Fetch, directory: File, cancelled: PublishedHttpsTransport.Cancellation): File? {
    val destination = File(directory, "video.mp4")
    var ownsDirectory = false
    var success = false
    val check = MediaHttpsFile.Check {
      PublishedHttpsTransport.checkCancellation(cancelled)
      fetch.deadline.timeoutMs(MediaHttpsFile.TOTAL_MS)
    }
    return try {
      check.run()
      if (!directory.isDirectory) directory.mkdir()
      check(OsConstants.S_ISDIR(Os.lstat(directory.path).st_mode))
      ownsDirectory = true
      check(destination.delete() || !destination.exists())
      var lastProgress = 0L
      MediaHttpsFile.download(row.url, PublishedHttpsRequestOwner.addressPolicy(), cancelled,
        fetch.deadline, destination) { written, total ->
        val now = SystemClock.elapsedRealtime()
        if (now - lastProgress >= 500 && fetch.progressPending.compareAndSet(false, true)) {
          lastProgress = now
          main.post {
            fetch.progressPending.set(false)
            if (session === row && row.fetching === fetch) {
              label?.text = "${row.hostName} · Downloading ${written * 100L / total}%"
            }
          }
        }
      }
      check(FiniteMp4.accepts(destination, check))
      check.run()
      success = true
      destination
    } catch (_: Exception) { null }
    finally {
      if (!success && ownsDirectory) destination.delete()
    }
  }

  private fun complete(row: Session, fetch: Fetch, file: File?) {
    downloading = false
    if (session !== row || row.fetching !== fetch || fetch.cancelled || !allowed() || !authorized(row)) { file?.delete(); return }
    row.fetching = null; stopButton?.text = "Close video"; label?.text = row.hostName
    if (file == null) { failed(row); return }
    row.file = file
    val video = SurfaceView(host.context)
    video.holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceCreated(holder: SurfaceHolder) { prepare(row, holder, file) }
      override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit
      override fun surfaceDestroyed(holder: SurfaceHolder) {
        if (session === row) {
          releasePlayer(row)
          row.consent = null
          row.started = false
          playButton?.isEnabled = true; playButton?.text = "Play video"
          capabilities(row)
        }
      }
    })
    row.view = video
    panel?.addView(video, 1, LinearLayout.LayoutParams(1, 1).apply { gravity = Gravity.CENTER_HORIZONTAL })
    layout()
  }

  private fun prepare(row: Session, holder: SurfaceHolder, file: File) {
    if (session !== row || row.file !== file || row.player != null || !allowed() || !authorized(row)) return
    val player = MediaPlayer()
    row.player = player
    main.postAtTime({
      if (session === row && row.player === player && !row.prepared) failed(row)
    }, row, android.os.SystemClock.uptimeMillis() + 10000)
    try {
      player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build())
      // Only the opened private file descriptor enters the platform player.
      file.inputStream().use { player.setDataSource(it.fd) }
      player.setOnPreparedListener {
        if (session === row && row.player === player) {
          row.decoderReady = true
          checkPlayer(row, holder, player, player.videoWidth, player.videoHeight)
        }
      }
      player.setOnVideoSizeChangedListener { _, width, height -> checkPlayer(row, holder, player, width, height) }
      player.setOnCompletionListener {
        if (session === row && row.player === player) {
          row.started = false; row.finished = true
          abandonAudioFocus(row)
          playButton?.text = "Play video"
          state(row, "stopped", "ended")
        }
      }
      player.setOnErrorListener { _, _, _ -> if (session === row && row.player === player) failed(row); true }
      player.prepareAsync()
    } catch (_: Exception) { failed(row) }
  }

  private fun checkPlayer(row: Session, holder: SurfaceHolder, player: MediaPlayer, width: Int, height: Int) {
    if (session !== row || row.player !== player || width == 0 && height == 0) return
    if (!FiniteMp4.validDimensions(width, height)) { failed(row); return }
    if (row.videoSize?.width != width || row.videoSize?.height != height) {
      row.videoSize = FiniteVideoSize(width, height)
      layout()
    }
    if (!row.decoderReady || row.prepared) return
    if (player.duration !in 1..3600000 || !holder.surface.isValid) { failed(row); return }
    try {
      player.setDisplay(holder)
      row.prepared = true
      player.setVolume(row.volume, row.volume)
      playButton?.isEnabled = true
      if (authorized(row) && allowed()) resume(row) else capabilities(row)
    } catch (_: Exception) { failed(row) }
  }

  @Suppress("DEPRECATION")
  private fun requestAudioFocus(row: Session): Boolean {
    if (row.focus != null) return true
    val revision = ++row.focusRevision
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      if (change < 0) main.post {
        if (session === row && row.focus != null && row.focusRevision == revision) { row.consent = null; pause(row, "focus-lost") }
      }
    }
    if (audio.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return false
    row.focus = listener
    return true
  }
  @Suppress("DEPRECATION")
  private fun abandonAudioFocus(row: Session) {
    val listener = row.focus ?: return
    row.focus = null
    audio.abandonAudioFocus(listener)
  }

  private fun resume(row: Session) {
    if (session !== row || !allowed() || !authorized(row) || !row.prepared) return
    val player = row.player ?: return
    if (!requestAudioFocus(row)) { row.consent = null; pause(row, "focus-lost"); return }
    if (row.finished) { row.finished = false; player.seekTo(0) }
    player.start(); row.started = true
    playButton?.isEnabled = true; playButton?.text = "Pause video"
    poll(row)
    capabilities(row)
  }
  private fun poll(row: Session) {
    main.removeCallbacksAndMessages(row)
    if (session !== row || !row.started) return
    if (!allowed() || !authorized(row)) { row.consent = null; pause(row, "focus-lost"); return }
    if (row.player?.duration?.let { it !in 1..3600000 } == true) { failed(row); return }
    state(row, status(row))
    main.postAtTime({ poll(row) }, row, android.os.SystemClock.uptimeMillis() + 500)
  }
  private fun pause(row: Session, reason: String) {
    row.started = false
    main.removeCallbacksAndMessages(row)
    row.fetching?.cancelled = true; row.fetching = null
    if (row.prepared) {
      row.player?.pause()
      abandonAudioFocus(row)
    } else {
      releasePlayer(row)
    }
    playButton?.isEnabled = true; playButton?.text = "Play video"
    stopButton?.text = "Close video"; label?.text = if (row.file == null) offer(row) else row.hostName
    state(row, "paused", reason)
    capabilities(row)
  }
  private fun capabilities(row: Session) {
    val actions = if (!row.prepared || !authorized(row)) listOf("pause", "stop", "volume") else listOf("play", "pause", "stop", "seek", "volume")
    row.push(JSONObject().put("type", "media.capabilities").put("sessionId", row.id).put("actions", JSONArray(actions)))
  }
  private fun status(row: Session) = when {
    row.finished -> "stopped"
    row.prepared && row.player?.isPlaying == true -> "playing"
    row.fetching != null || row.started -> "buffering"
    else -> "paused"
  }
  private fun state(row: Session, status: String, reason: String? = null) {
    val value = JSONObject().put("type", "media.state").put("sessionId", row.id).put("status", status).put("volume", row.volume.toDouble())
    if (reason != null) value.put("reason", reason)
    if (row.prepared && reason != "error") row.player?.let {
      value.put("position", it.currentPosition.coerceIn(0, 3600000) / 1000.0)
      if (it.duration >= 0) value.put("duration", it.duration.coerceAtMost(3600000) / 1000.0)
    }
    row.push(value)
  }

  fun focusChanged() {
    val row = session ?: return
    val focused = allowed()
    panel?.visibility = if (focused) View.VISIBLE else View.INVISIBLE
    if (!focused) {
      row.consent = null
      pause(row, "focus-lost")
    }
  }
  private fun authorized(row: Session) = row.consent?.let { permit() == it } == true
  private fun failed(row: Session) { state(row, "stopped", "error"); retire("error") }
  private fun releasePlayer(row: Session) {
    val player = row.player
    row.prepared = false; row.decoderReady = false
    runCatching { player?.setVolume(0f, 0f) }
    val released = runCatching { player?.release() }.isSuccess
    if (released) row.player = null else row.releaseUncertain = true
    if (runCatching { abandonAudioFocus(row) }.isFailure) row.releaseUncertain = true
    if (row.releaseUncertain) MediaPlaybackReservation.uncertain(row)
  }
  fun retire(reason: String? = null) {
    val row = session ?: return
    session = null; row.retired = true; MediaPlaybackReservation.draining(row); if (active === this) active = null
    row.fetching?.cancelled = true; row.fetching = null
    main.removeCallbacksAndMessages(row)
    releasePlayer(row); releaseReservation(row); row.file?.delete()
    panel?.let(host::removeView); panel = null; label = null; playButton = null; stopButton = null
    if (reason != null) row.push(JSONObject().put("type", "media.session.ended").put("sessionId", row.id).put("reason", reason))
  }
  private fun releaseReservation(row: Session) {
    if (row.reserved && row.retired && !row.networkActive && row.player == null && !row.releaseUncertain) {
      row.reserved = false; MediaPlaybackReservation.release(row)
    }
  }
  companion object {
    private val requestId = Regex("[!-~]{1,128}")
    private val createFields = setOf("type", "id", "url")
    private val commandFields = setOf("type", "sessionId", "action", "value")
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "hypergolic-finite-video").apply { isDaemon = true } }
    private var active: NativeFiniteVideo? = null
    private var downloading = false
    fun revokeGenerations(generations: Set<String>) {
      active?.takeIf { it.generation in generations }?.retire("policy")
    }
  }
}
