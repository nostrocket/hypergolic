package org.nostrocket.hypergolic.host

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.MediaDataSource
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper

/** Native byte-only output. The single decoder looper can mute on native revocation even while UI is busy. */
internal class LiveMP3Decoder(context: Context, private val source: MediaDataSource,
  private val permitted: () -> Boolean, private val output: () -> Unit, private val ended: () -> Unit,
  private val failed: () -> Unit, private val focusLost: () -> Unit) {
  init { require(source is LiveMP3Source) }
  private val main = Handler(Looper.getMainLooper())
  private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
  private var player: MediaPlayer? = null
  private var closed = false
  @Volatile private var retiring = false
  private var notified = false
  private var firstOutput = false
  private val cleanup = LiveMP3Cleanup()
  private var focus: AudioFocusRequest? = null
  private val tick = object : Runnable {
    override fun run() {
      val current = player ?: return
      if (closed || retiring) return
      if (!permitted()) { policyStop(); return }
      try {
        val stamp = current.timestamp
        if (!firstOutput && stamp != null && stamp.anchorMediaTimeUs > 0) { firstOutput = true; output() }
      } catch (_: Exception) { failure(); return }
      decoder.postDelayed(this, 20)
    }
  }
  fun prepare() { decoder.post { prepareOwned() } }
  private fun prepareOwned() {
    if (closed || retiring) return
    if (player != null || !permitted()) { policyStop(); return }
    try {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes)
        .setAcceptsDelayedFocusGain(false).setOnAudioFocusChangeListener({ change ->
          if (change < 0 && !closed && !retiring) policyStop()
        }, decoder).build()
      focus = request
      if (audio.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { failure(); return }
      val current = MediaPlayer(); player = current
      current.setAudioAttributes(attributes)
      current.setDataSource(source)
      current.setVolume(1f, 1f)
      current.setOnPreparedListener {
        if (closed || retiring || player !== current) return@setOnPreparedListener
        if (!permitted()) { policyStop(); return@setOnPreparedListener }
        try { current.start(); decoder.post(tick) } catch (_: Exception) { failure() }
      }
      current.setOnCompletionListener {
        if (!closed && !retiring && player === current && permitted() && !notified) {
          notified = true; main.post(ended)
        }
      }
      current.setOnErrorListener { _, _, _ -> if (!closed && !retiring && player === current) failure(); true }
      current.prepareAsync()
    } catch (_: Exception) { failure() }
  }
  private fun failure() {
    if (closed || notified) return
    notified = true; retiring = true; runCatching { source.close() }; decoder.removeCallbacks(tick)
    runCatching { player?.setVolume(0f, 0f) }; runCatching { player?.pause() }
    main.post(failed)
  }
  private fun policyStop() {
    if (closed || notified) return
    notified = true; retiring = true; runCatching { source.close() }; decoder.removeCallbacks(tick)
    runCatching { player?.setVolume(0f, 0f) }; runCatching { player?.pause() }
    main.post(focusLost)
  }
  /** Revoke reads immediately; report drain only after persistent, exception-safe native cleanup. */
  fun close(drained: (Boolean) -> Unit) {
    retiring = true; runCatching { source.close() }
    decoder.post {
      closed = true
      val current = player; val request = focus
      val released = cleanup.close(
        { decoder.removeCallbacks(tick) },
        { current?.setVolume(0f, 0f) },
        { current?.setOnPreparedListener(null); current?.setOnErrorListener(null); current?.setOnCompletionListener(null) },
        { request?.let { audio.abandonAudioFocusRequest(it) } },
        { current?.release() }
      )
      if (released) { player = null; focus = null }
      main.post { drained(released) }
    }
  }
  companion object {
    // A single idle looper per process, not a new unbounded queue/thread for every resume.
    private val decoder = Handler(HandlerThread("hypergolic-live-decoder").apply { isDaemon = true; start() }.looper)
  }
}
