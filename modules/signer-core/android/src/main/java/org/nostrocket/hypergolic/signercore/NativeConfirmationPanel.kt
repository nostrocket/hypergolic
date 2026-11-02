package org.nostrocket.hypergolic.signercore

import android.app.Activity
import android.app.AlertDialog
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** A native user gesture authorizes the exact public identity change; no bridge approval flag exists. */
internal class NativeConfirmationPanel {
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var close: (() -> Unit)? = null

  suspend fun confirm(activity: Activity, title: String, detail: String, positiveLabel: String = "Switch identity", onAccepted: (() -> Unit)? = null, valid: () -> Boolean): Boolean {
    if (close != null || activity.isFinishing || activity.isDestroyed || !valid()) {
      throw NativeVault.Error("AUTHORIZATION_DENIED")
    }
    return suspendCancellableCoroutine { continuation ->
      val dialog = AlertDialog.Builder(activity)
        .setTitle(title)
        .setMessage(detail)
        .setPositiveButton(positiveLabel, null)
        .setNegativeButton("Cancel", null)
        .create()
      var settled = false
      lateinit var poll: Runnable
      fun finish(accepted: Boolean) {
        if (settled) return
        settled = true
        close = null
        main.removeCallbacks(poll)
        dialog.setOnDismissListener(null)
        dialog.dismiss()
        if (continuation.isActive) continuation.resume(accepted)
      }
      poll = Runnable {
        if (!valid()) finish(false) else main.postDelayed(poll, 200)
      }
      close = { finish(false) }
      continuation.invokeOnCancellation { main.post { finish(false) } }
      dialog.setOnCancelListener { finish(false) }
      dialog.setOnDismissListener { finish(false) }
      dialog.show()
      dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener { finish(false) }
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).apply {
        filterTouchesWhenObscured = true
        setOnTouchListener { _, event ->
          event.flags and (MotionEvent.FLAG_WINDOW_IS_OBSCURED or MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) != 0
        }
        setOnClickListener {
          val accepted = valid()
          if (accepted) onAccepted?.invoke()
          finish(accepted)
        }
      }
      main.postDelayed(poll, 200)
    }
  }

  fun cancellation(): () -> Unit {
    val captured = close
    return {
      if (Looper.myLooper() == Looper.getMainLooper()) captured?.invoke()
      else main.post { captured?.invoke() }
      Unit
    }
  }
  fun cancel() = cancellation().invoke()
}
