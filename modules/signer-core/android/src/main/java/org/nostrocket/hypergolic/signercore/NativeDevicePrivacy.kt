package org.nostrocket.hypergolic.signercore

import android.app.Activity
import android.app.Dialog
import android.app.Application
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.nostrocket.hypergolic.identityowner.SystemDeletionAuthentication
import java.lang.ref.WeakReference

internal object NativeDevicePrivacy {
  private const val WORKSPACE = "workspace"
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val authentication = SystemDeletionAuthentication()
  private var activityRef = WeakReference<Activity>(null)
  private var installed = false
  private var hostClass: Class<out Activity>? = null
  @Volatile private var locked = true
  private var generation = 0L
  @Volatile private var away: Long? = null
  private var opening: CompletableDeferred<Unit>? = null
  private var curtain: Dialog? = null
  private var addedSecureFlag = false
  private fun settings(context: Context) = context.getSharedPreferences("hypergolic-device-privacy-v1", Context.MODE_PRIVATE)
  private fun enabled(activity: Activity) = settings(activity).getBoolean(WORKSPACE, false)
  fun accessible(activity: Activity) = !enabled(activity) ||
    (!locked && !deviceLocked(activity) && away?.let { SystemClock.elapsedRealtime() - it >= 60_000 } != true)
  fun requiresSigning(activity: Activity, pubkey: String, external: Boolean) =
    settings(activity).getBoolean((if (external) "external." else "local.") + pubkey, false)

  suspend fun prepare(activity: Activity): Boolean {
    if (!installed) {
      installed = true
      hostClass = activity.javaClass
      activity.application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(value: Activity, state: Bundle?) {}
        override fun onActivityStarted(value: Activity) {
          if (value.javaClass == hostClass) attach(value)
        }
        override fun onActivityResumed(value: Activity) {
          if (value !== activityRef.get()) return
          if (away?.let { SystemClock.elapsedRealtime() - it >= 60_000 } == true || deviceLocked(value)) locked = true
          away = null
          refresh(value)
        }
        override fun onActivityPaused(value: Activity) {
          if (value === activityRef.get() && away == null) away = SystemClock.elapsedRealtime()
        }
        override fun onActivityStopped(value: Activity) {
          if (value === activityRef.get()) { generation++; authentication.cancel() }
        }
        override fun onActivitySaveInstanceState(value: Activity, state: Bundle) {}
        override fun onActivityDestroyed(value: Activity) {
          if (value === activityRef.get()) { dismiss(); generation++; authentication.cancel() }
        }
      })
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { if (intent.action == Intent.ACTION_SCREEN_OFF) lock() }
      }
      val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
      if (Build.VERSION.SDK_INT >= 33) activity.application.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      else activity.application.registerReceiver(receiver, filter)
    }
    attach(activity)
    if (accessible(activity)) return true
    val pending = opening ?: CompletableDeferred<Unit>().also { opening = it }
    pending.await()
    return accessible(activity)
  }
  private fun attach(activity: Activity) {
    if (activity !== activityRef.get()) {
      dismiss()
      activityRef = WeakReference(activity)
      addedSecureFlag = false
    }
    refresh(activity)
  }
  private fun deviceLocked(activity: Activity) =
    activity.getSystemService(KeyguardManager::class.java)?.isDeviceLocked != false

  private fun refresh(activity: Activity) {
    if (activity.isDestroyed || activity.isFinishing) return
    val enabled = enabled(activity)
    if (Build.VERSION.SDK_INT >= 33) activity.setRecentsScreenshotEnabled(!enabled)
    else if (enabled && activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0) {
      activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      addedSecureFlag = true
    } else if (!enabled && addedSecureFlag) {
      activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      addedSecureFlag = false
    }
    if (!enabled || !locked) { dismiss(); return }
    if (curtain != null) return
    val content = android.widget.Button(activity)
    content.text = "Unlock Hypergolic"
    content.setOnClickListener {
      scope.launch {
        if (confirm(activity, "Unlock Hypergolic", "Unlock your workspace.") { locked }) {
          locked = false
          dismiss()
          opening?.complete(Unit)
          opening = null
        }
      }
    }
    val layout = android.widget.FrameLayout(activity)
    layout.setBackgroundColor(android.graphics.Color.rgb(20, 24, 31))
    layout.addView(content, android.widget.FrameLayout.LayoutParams(-2, -2, android.view.Gravity.CENTER))
    val panel = Dialog(activity, android.R.style.Theme_Material_NoActionBar_Fullscreen)
    panel.setContentView(layout)
    panel.setCancelable(false)
    curtain = panel
    panel.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    panel.show()
    panel.window?.setLayout(-1, -1)
  }
  private fun dismiss() { curtain?.dismiss(); curtain = null }
  fun cancelExpiredPrompt() = authentication.cancel()
  fun lock() {
    locked = true
    generation++
    authentication.cancel()
    activityRef.get()?.let(::refresh)
  }
  suspend fun confirm(activity: Activity, title: String, explanation: String, valid: () -> Boolean): Boolean {
    val epoch = generation
    val current = { generation == epoch && activityRef.get() === activity && !activity.isFinishing && !activity.isDestroyed && valid() }
    return runCatching { authentication.authenticate(activity, title, explanation, "", current) && current() && !deviceLocked(activity) }.getOrDefault(false)
  }
  fun preferences(activity: Activity, pubkey: String) = mapOf("workspace" to enabled(activity),
    "local" to requiresSigning(activity, pubkey, false), "external" to requiresSigning(activity, pubkey, true))
  suspend fun configure(activity: Activity, mode: String, pubkey: String, value: Boolean): Boolean {
    if (!pubkey.matches(Regex("[0-9a-f]{64}")) || mode !in setOf(WORKSPACE, "local", "external")) return false
    val action = if (value) "Enable" else "Disable"
    val target = when (mode) {
      WORKSPACE -> "workspace lock"
      "local" -> "local signing confirmation for $pubkey"
      else -> "external signer confirmation for $pubkey"
    }
    if (!confirm(activity, "Change privacy settings", "$action $target") { accessible(activity) }) return false
    val key = if (mode == WORKSPACE) WORKSPACE else "$mode.$pubkey"
    if (!settings(activity).edit().putBoolean(key, value).commit()) return false
    if (mode == WORKSPACE) { locked = false; refresh(activity) }
    return true
  }
}

class HypergolicDevicePrivacyModule : Module() {
  private fun activity() = requireNotNull(appContext.currentActivity)
  override fun definition() = ModuleDefinition {
    Name("HypergolicDevicePrivacy")
    AsyncFunction("prepare") Coroutine { -> withContext(Dispatchers.Main.immediate) { NativeDevicePrivacy.prepare(activity()) } }
    AsyncFunction("preferences") Coroutine { pubkey: String -> withContext(Dispatchers.Main.immediate) { NativeDevicePrivacy.preferences(activity(), pubkey) } }
    AsyncFunction("configure") Coroutine { mode: String, pubkey: String, value: Boolean ->
      withContext(Dispatchers.Main.immediate) { NativeDevicePrivacy.configure(activity(), mode, pubkey, value) }
    }
    AsyncFunction("lock") Coroutine { -> withContext(Dispatchers.Main.immediate) { NativeDevicePrivacy.lock() } }
  }
}
