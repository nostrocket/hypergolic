package org.nostrocket.hypergolic.host

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.Executors

/** Dormant until a host supplies the separately reviewed profile and invokes nativePlay from its own UI. */
internal class LiveMP3Playback(private val context: Context, private val url: String, private val profile: String?,
  private val scope: String, private val currentPermit: () -> String?, private val event: (String) -> Unit) {
  private val owner = LiveMP3Owner(profile, scope, { SystemClock.elapsedRealtime() }, LiveMP3Budget.SESSION_MS)
  private val main = Handler(Looper.getMainLooper())
  private var attempt = 0L
  private var buffer: LiveMP3Buffer? = null
  private var decoder: LiveMP3Decoder? = null
  private var terminal: String? = null
  private var pauseDelivered = false
  private var expiryArmed = false
  private val expiry = Runnable { retire("policy") }
  private val watch = object : Runnable {
    override fun run() {
      if (owner.phase() != LiveMP3Owner.Phase.PLAYING && owner.phase() != LiveMP3Owner.Phase.BUFFERING) return
      if (!valid(attempt)) { retire("policy"); return }
      main.postDelayed(this, 25)
    }
  }
  /** Guest play commands must never invoke this method; exact native source Play is the entry point. */
  fun nativePlay(): Boolean {
    check(Looper.myLooper() == Looper.getMainLooper())
    if (profile != LiveMP3Owner.PROFILE || terminal != null || runCatching { PublishedHttpsTransport.validateRequest(url, PublishedHttpsRequestOwner.addressPolicy()) }.isFailure) return false
    val receipt = currentPermit() ?: return false
    val token = try { owner.nativePlay(scope, receipt, true, true) } catch (_: Exception) {
      if (owner.phase() == LiveMP3Owner.Phase.ENDED) { terminal = "policy"; deliverTerminal() }
      return false
    }
    attempt = token; pauseDelivered = false
    try {
    owner.retain(this)
    if (!expiryArmed) {
      expiryArmed = true; main.postDelayed(expiry, owner.budget(token).remainingMillis())
    }
    val bytes = LiveMP3Buffer { owner.check(token, scope, currentPermit(), true, true) }; buffer = bytes
    val player = LiveMP3Decoder(context, LiveMP3Source(bytes), { valid(token) }, {
      if (valid(token)) runCatching { owner.output(token) }.onSuccess {
        main.post { if (attempt == token && valid(token)) publish("playing") }
      }
    }, { retire("ended") }, { retire("error") }, { pause("focus-lost") })
    decoder = player
    publish("buffering"); main.post(watch)
    player.prepare()
    worker.execute {
      try {
        val gate = LiveMP3Gate(bytes::append)
        LiveMP3HTTPS.stream(url, PublishedHttpsRequestOwner.addressPolicy(), { !valid(token) }, owner.budget(token), gate)
        gate.finish(); owner.budget(token).finishedTransport(); bytes.finish()
      } catch (_: Exception) {
        main.post { if (attempt == token && owner.phase() != LiveMP3Owner.Phase.STOPPING && terminal == null) retire("error") }
      } finally { main.post { owner.drained(token, true); completeDrain() } }
    }
    return true
    } catch (_: Exception) {
      owner.drained(token, true)
      retire("error")
      return false
    }
  }
  private fun valid(token: Long): Boolean = runCatching {
    owner.check(token, scope, currentPermit(), true, true)
  }.isSuccess
  fun pause(reason: String = "user") {
    check(Looper.myLooper() == Looper.getMainLooper())
    if (terminal != null || owner.phase() == LiveMP3Owner.Phase.STOPPING || owner.phase() == LiveMP3Owner.Phase.PAUSED) return
    owner.pause(); terminal = owner.reason(); main.removeCallbacks(watch); buffer?.cancel()
    val token = attempt
    decoder?.close { released ->
      if (released) { owner.drained(token, false); decoder = null; completeDrain() }
      else { terminal = "backend-exited"; owner.retire(); owner.uncertainCleanup(); deliverTerminal() }
    }
    if (decoder == null) completeDrain()
    if (reason == "focus-lost") publish("focus-lost")
  }
  fun retire(reason: String) {
    check(Looper.myLooper() == Looper.getMainLooper())
    if (!owner.retire(reason)) return
    terminal = reason; main.removeCallbacks(watch); main.removeCallbacks(expiry); buffer?.cancel()
    val token = attempt
    val current = decoder
    if (current == null) { owner.drained(token, false); completeDrain(); return }
    current.close { released ->
      if (released) { owner.drained(token, false); decoder = null; completeDrain() }
      else { terminal = "backend-exited"; owner.uncertainCleanup(); deliverTerminal() }
    }
  }
  private fun completeDrain() {
    if (!owner.drained()) return
    buffer = null
    if (terminal != null || owner.reason() != null) deliverTerminal()
    else if (!pauseDelivered && owner.phase() == LiveMP3Owner.Phase.PAUSED) { pauseDelivered = true; publish("paused") }
  }
  private fun publish(value: String) {
    try { event(value) } catch (_: Exception) { retire("backend-exited") }
  }
  private fun deliverTerminal() {
    val reason = owner.takeTerminal() ?: return
    main.removeCallbacks(expiry)
    publish("ended:" + reason)
  }
  companion object {
    // One task can be in flight globally: the owner slot is not released until this task and decoder drain.
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "hypergolic-live-mp3").apply { isDaemon = true } }
  }
}
