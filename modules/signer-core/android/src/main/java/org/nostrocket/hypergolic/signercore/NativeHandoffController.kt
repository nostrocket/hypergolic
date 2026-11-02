package org.nostrocket.hypergolic.signercore

import android.app.KeyguardManager
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.os.Build
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.os.UserManager
import expo.modules.kotlin.AppContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicReference
import org.nostrocket.hypergolic.host.NativeSignerAuthorizationUrl
import org.nostrocket.hypergolic.host.NativeSigningSourceFacade

/** Native consent and exact browser continuation; ordinary session revocation remains in force. */
internal class NativeHandoffController internal constructor(
  private val owner: Any, private val isForeground: () -> Boolean, private val platform: Platform,
) {
  constructor(owner: AppContext, foreground: () -> Boolean) : this(owner, foreground, SystemPlatform(owner))

  /** Native-only owning-test port. The production constructor always uses AppContext and OS services. */
  interface Platform {
    fun activity(): Activity?
    fun unlocked(): Boolean
    fun validate(raw: String, cancelled: () -> Boolean, deadline: Long): String
    fun browser(activity: Activity): String
    fun launch(activity: Activity, raw: String, browser: String)
    suspend fun confirm(activity: Activity, title: String, detail: String, button: String, valid: () -> Boolean): Boolean
    fun cancelPrompt()
    fun watchLock(activity: Activity, revoke: () -> Unit): () -> Unit
  }
  private class Receipt(val marker: Any, val binding: Binding.Signing, val deadline: Long)
  private val completed = AtomicReference<Receipt?>(null)
  sealed class Binding {
    class Signing(val kind: String, val token: String, val source: NativeSigningSourceFacade.Capture) : Binding()
    class Preparation(val vault: String, val revision: Long, val attempt: String, val purpose: String) : Binding()
  }
  class Checks(val live: () -> Boolean, val captured: () -> Boolean, val cancel: () -> Unit)
  private val main = Handler(Looper.getMainLooper())
  private val current = AtomicReference<Authorization?>(null)
  private var resumePrompt: Authorization? = null

  inner class Authorization internal constructor(
    val binding: Binding, val epoch: Long, val deadline: Long, private val checks: Checks,
  ) : NativeNip46Client.Authorization {
    val identity = Any()
    @Volatile var ticket: NativeHandoffTicket? = null
      private set
    @Volatile private var locked = false
    private var unwatch: (() -> Unit)? = null
    private var watch: Runnable? = null
    private fun captured(): Boolean = runCatching {
      !locked && unlocked() && SystemClock.elapsedRealtime() < deadline && checks.captured() &&
        (binding !is Binding.Signing || binding.source.handoffActive())
    }.getOrDefault(false)
    fun state(): String? {
      val value = ticket ?: return null
      if (current.get() !== this || !captured()) return null
      if (current.get() !== this) return null
      return value.state(owner, this, SystemClock.elapsedRealtime())
    }
    fun receive(): Boolean = if (ticket == null) checks.live() else state() != null
    fun execute(): Boolean = if (ticket == null) checks.live() else state() == "resumed" && isForeground() &&
      (binding !is Binding.Signing || binding.source.resumedHandoff())
    override fun challenge(requestId: String, raw: String) {
      if (ticket != null || current.get() != null || !checks.live() || !unlocked()) throw NativeVault.Error("SIGNER_UNSUPPORTED")
      val origin = platform.validate(raw, { !checks.live() }, deadline)
      runBlocking { withContext(Dispatchers.Main.immediate) {
        if (current.get() != null || !checks.live() || !unlocked()) throw NativeVault.Error("AUTHORIZATION_DENIED")
        val activity = platform.activity() ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
        val browser = platform.browser(activity)
        if (!platform.confirm(activity, "Open signer authorization?",
          "Authorization website:\n$origin\n\nYour original request stays paused until you return and choose Resume.", "Open browser") {
          current.get() == null && checks.live() && unlocked()
        }) throw NativeVault.Error("AUTHORIZATION_DENIED")
        if (current.get() != null || !checks.live() || !unlocked()) throw NativeVault.Error("AUTHORIZATION_DENIED")
        install(requestId, activity)
        try { platform.launch(activity, raw, browser) }
        catch (_: Exception) {
          cancel(this@Authorization)
          throw NativeVault.Error("SIGNER_UNAVAILABLE")
        }
      } }
    }
    /** Called only after native Android signer selection/review, before the explicit package Intent. */
    fun beginActivity(requestId: String) {
      check(Looper.myLooper() == Looper.getMainLooper())
      if (ticket != null || current.get() != null || !checks.live() || !unlocked()) throw NativeVault.Error("AUTHORIZATION_DENIED")
      val activity = platform.activity() ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
      install(requestId, activity)
    }
    fun activityCurrent(requestId: String, expectedDeadline: Long): Boolean =
      ticket?.requestId == requestId && deadline == expectedDeadline && state() != null
    private fun install(requestId: String, activity: Activity) {
      if (binding is Binding.Signing && !binding.source.armHandoff(deadline)) throw NativeVault.Error("AUTHORIZATION_DENIED")
      ticket = NativeHandoffTicket(owner, this, epoch, deadline, requestId)
      if (!current.compareAndSet(null, this)) {
        ticket?.cancel()
        checks.cancel()
        throw NativeVault.Error("AUTHORIZATION_DENIED")
      }
      try {
        val detach = platform.watchLock(activity) {
          if (current.get() === this) { locked = true; discard() }
        }
        unwatch = detach
        if (current.get() !== this) { unwatch = null; detach(); throw NativeVault.Error("AUTHORIZATION_DENIED") }
        scheduleWatch(this)
      } catch (failure: Exception) { discard(); throw NativeVault.Error("AUTHORIZATION_DENIED") }
    }
    fun stopWatching() {
      watch?.let(main::removeCallbacks); watch = null
      val detach = unwatch; unwatch = null
      runCatching { detach?.invoke() }
      main.post { if (resumePrompt === this) { resumePrompt = null; platform.cancelPrompt() } }
    }
    fun watch(task: Runnable) { watch = task }
    override fun awaitResume(requestId: String) {
      val value = ticket ?: return
      if (state() == "resumed") {
        if (!execute()) throw NativeVault.Error("AUTHORIZATION_DENIED")
        return
      }
      if (current.get() !== this || !value.verifiedResult(owner, this, requestId, SystemClock.elapsedRealtime())) {
        throw NativeVault.Error(if (state() == null) "AUTHORIZATION_DENIED" else "SIGNER_RESPONSE_INVALID")
      }
      main.post { offerResume(this@Authorization) }
      while (state() == "pending") Thread.sleep(100)
      if (!execute()) throw NativeVault.Error("AUTHORIZATION_DENIED")
    }
    fun discard() {
      val value = ticket ?: return
      if (!current.compareAndSet(this, null)) return
      value.cancel()
      stopWatching()
      checks.cancel()
    }
  }
  fun authorization(binding: Binding, epoch: Long, deadline: Long, checks: Checks): Authorization =
    Authorization(binding, epoch, deadline, checks)
  private fun unlocked(): Boolean = platform.unlocked()
  private fun scheduleWatch(value: Authorization) {
    val task = object : Runnable {
      override fun run() {
        if (current.get() !== value) return
        if (value.state() == null) cancel(value)
        else {
          if (value.ticket?.readyForResume() == true && isForeground()) offerResume(value)
          main.postDelayed(this, 200)
        }
      }
    }
    value.watch(task)
    main.postDelayed(task, 200)
  }
  fun background(): Boolean {
    completed.set(null)
    val value = current.get() ?: return false
    value.ticket?.background()
    val preserve = value.state() != null
    if (!preserve) cancel(value)
    return preserve
  }
  fun foreground() {
    val value = current.get() ?: return
    value.ticket?.foreground()
    main.postDelayed({ offerResume(value) }, 100)
  }
  private fun offerResume(value: Authorization) {
    if (current.get() !== value || value.state() != "pending" || value.ticket?.readyForResume() != true) return
    if (!isForeground()) { main.postDelayed({ offerResume(value) }, 100); return }
    if (current.get() !== value || resumePrompt != null) return
    resumePrompt = value
    kotlinx.coroutines.CoroutineScope(Dispatchers.Main.immediate).launch {
      try {
        val activity = platform.activity() ?: return@launch
        val accepted = platform.confirm(activity, "Resume signer request?",
          "Continue only the original signer request. Other approvals remain paused.", "Resume") {
          current.get() === value && value.state() == "pending" && isForeground() && unlocked()
        }
        if (current.get() !== value) return@launch
        if (!accepted || value.state() != "pending" || !isForeground() || !unlocked()) { cancel(value); return@launch }
        val binding = value.binding
        val resumed = if (binding is Binding.Signing) binding.source.resumeHandoff {
          current.get() === value && value.state() == "pending" &&
            value.ticket?.resume(owner, value, SystemClock.elapsedRealtime()) == true
        } else current.get() === value && value.state() == "pending" &&
            value.ticket?.resume(owner, value, SystemClock.elapsedRealtime()) == true
        if (!resumed) cancel(value)
      } catch (_: Exception) {
        if (current.get() === value) cancel(value)
      } finally { if (resumePrompt === value) resumePrompt = null }
    }
  }
  fun signingState(kind: String, token: String): String? {
    val value = current.get()
    val binding = value?.binding as? Binding.Signing
    if (binding?.kind == kind && binding.token == token) return value?.state()
    val receipt = completed.get() ?: return null
    if (receipt.binding.kind != kind || receipt.binding.token != token) return null
    val valid = runCatching { unlocked() && isForeground() && SystemClock.elapsedRealtime() < receipt.deadline &&
      receipt.binding.source.resumedHandoff() }.getOrDefault(false)
    if (!valid) { completed.compareAndSet(receipt, null); return null }
    return if (completed.get() === receipt) "resumed" else null
  }
  fun preparationState(vault: String, revision: Long, attempt: String): String? {
    val value = current.get() ?: return null
    val binding = value.binding as? Binding.Preparation ?: return null
    return if (binding.vault == vault && binding.revision == revision && binding.attempt == attempt) value.state() else null
  }
  fun retained(value: Authorization): Boolean = current.get() === value && value.state() != null
  fun complete(value: Authorization) {
    val previous = completed.get()
    val binding = value.binding as? Binding.Signing
    val marker = if (binding != null && value.state() == "resumed" && unlocked() && isForeground())
      Receipt(value.identity, binding, value.deadline) else null
    if (!current.compareAndSet(value, null)) return
    if (marker != null) completed.compareAndSet(previous, marker)
    value.ticket?.cancel()
    value.stopWatching()
  }
  /** Captures native identities only; callers can collect this under their session lock, then run it outside. */
  fun cancellation(kind: String? = null, token: String? = null): () -> Unit {
    val value = current.get()?.takeIf {
      val binding = it.binding as? Binding.Signing
      kind == null || binding?.kind == kind && binding.token == token
    }
    val receipt = completed.get()?.takeIf { kind == null || it.binding.kind == kind && it.binding.token == token }
    return {
      value?.discard()
      if (receipt != null && completed.compareAndSet(receipt, null)) cancelReceipt(receipt)
    }
  }
  fun cancelSigning(kind: String, token: String) = cancellation(kind, token).invoke()
  fun cancel(value: Authorization) {
    val receipt = completed.get()?.takeIf { it.marker === value.identity }
    value.discard()
    if (receipt != null && completed.compareAndSet(receipt, null)) cancelReceipt(receipt)
  }
  fun cancel() = cancellation().invoke()
  private fun cancelReceipt(receipt: Receipt) {
    receipt.binding.source.cancelHandoff {
      NativeSigningSourceFacade.cancel(receipt.binding.kind, receipt.binding.token)
    }
  }

  private class SystemPlatform(private val owner: AppContext) : Platform {
    private val confirmation = NativeConfirmationPanel()
    override fun activity(): Activity? = owner.currentActivity
    override fun unlocked(): Boolean {
      val context = owner.runtime.reactContext ?: return false
      val users = context.getSystemService(UserManager::class.java) ?: return false
      val keyguard = context.getSystemService(KeyguardManager::class.java) ?: return false
      val power = context.getSystemService(PowerManager::class.java) ?: return false
      return users.isUserUnlocked && !keyguard.isDeviceLocked && power.isInteractive
    }
    override fun validate(raw: String, cancelled: () -> Boolean, deadline: Long): String =
      NativeSignerAuthorizationUrl.validate(raw, { cancelled() }, deadline)
    override fun browser(activity: Activity): String {
      val packages = activity.packageManager
      val browserIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_BROWSER)
      val browsers = packages.queryIntentActivities(browserIntent, 0).map { it.activityInfo.packageName }.toSet()
      val resolved = packages.resolveActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://example.org/"))
        .addCategory(Intent.CATEGORY_BROWSABLE), android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)
      return resolved?.activityInfo?.packageName?.takeIf { it in browsers } ?: throw NativeVault.Error("SIGNER_UNAVAILABLE")
    }
    override fun launch(activity: Activity, raw: String, browser: String) {
      activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(raw)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(browser))
    }
    override suspend fun confirm(activity: Activity, title: String, detail: String, button: String, valid: () -> Boolean): Boolean =
      confirmation.confirm(activity, title, detail, button, valid = valid)
    override fun cancelPrompt() = confirmation.cancel()
    override fun watchLock(activity: Activity, revoke: () -> Unit): () -> Unit {
      val context = activity.applicationContext
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          if (intent?.action == Intent.ACTION_SCREEN_OFF) revoke()
        }
      }
      val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
      if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      else context.registerReceiver(receiver, filter)
      return { runCatching { context.unregisterReceiver(receiver) }; Unit }
    }
  }
}
