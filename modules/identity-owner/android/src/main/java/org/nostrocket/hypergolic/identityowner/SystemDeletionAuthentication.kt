package org.nostrocket.hypergolic.identityowner

import android.app.Activity
import android.app.KeyguardManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/** API 30+ system-owned credential/strong-biometric dialog. No JS-supplied authentication result. */
class SystemDeletionAuthentication {
  private val main = Handler(Looper.getMainLooper())
  private class Pending(val signal: CancellationSignal, val canPresent: () -> Boolean, val finish: (Boolean) -> Unit)
  // Accessed on the main thread only. Exact object identity protects later prompts from stale callbacks.
  private var pending: Pending? = null

  fun available(activity: Activity): Boolean {
    if (Build.VERSION.SDK_INT < 30 || activity.isFinishing || activity.isDestroyed) return false
    val keyguard = activity.getSystemService(KeyguardManager::class.java) ?: return false
    val biometrics = activity.getSystemService(BiometricManager::class.java) ?: return false
    return keyguard.isDeviceSecure && biometrics.canAuthenticate(
      BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    ) == BiometricManager.BIOMETRIC_SUCCESS
  }

  internal suspend fun authenticate(activity: Activity, details: DeletionAuthority.Prompt, canPresent: () -> Boolean): Boolean =
    authenticate(activity, details.title, details.explanation, details.description, canPresent)

  suspend fun authenticate(activity: Activity, title: String, explanation: String, description: String,
    canPresent: () -> Boolean): Boolean = withContext(Dispatchers.Main.immediate) {
    if (!available(activity) || pending != null || !canPresent()) throw DeletionAuthority.Denied()
    suspendCancellableCoroutine { continuation ->
      val signal = CancellationSignal()
      lateinit var request: Pending
      request = Pending(signal, canPresent) { accepted ->
        if (pending === request) {
          pending = null
          if (continuation.isActive) continuation.resume(accepted)
        }
      }
      pending = request
      continuation.invokeOnCancellation { main.post {
        if (pending === request) { pending = null; signal.cancel() }
      } }
      if (Build.VERSION.SDK_INT < 30 || !continuation.isActive || !canPresent()) {
        request.finish(false)
        return@suspendCancellableCoroutine
      }
      try {
        val prompt = BiometricPrompt.Builder(activity)
          .setTitle(title)
          .setSubtitle(explanation)
          .setDescription(description)
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
          .setConfirmationRequired(true)
          .build()
        prompt.authenticate(signal, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            val type = result.authenticationType
            request.finish(type == BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC || type == BiometricPrompt.AUTHENTICATION_RESULT_TYPE_DEVICE_CREDENTIAL)
          }
          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { request.finish(false) }
          // A rejected fingerprint leaves the system prompt available for another try or cancellation.
        })
      } catch (_: Exception) { request.finish(false); signal.cancel() }
    }
  }
  /** Authority is revoked synchronously before the caller schedules this UI cleanup. */
  fun cancel() { main.post {
    val request = pending ?: return@post
    if (request.canPresent()) return@post // A stale cancellation cannot dismiss a newer valid prompt.
    request.finish(false)
    request.signal.cancel()
  } }
}
