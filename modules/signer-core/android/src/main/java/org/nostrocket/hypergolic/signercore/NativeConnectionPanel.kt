package org.nostrocket.hypergolic.signercore

import android.app.Activity
import android.app.AlertDialog
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.suspendCancellableCoroutine

/** Native secret entry. No secret-bearing text or callback crosses Expo. */
internal class NativeConnectionPanel {
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var pending: (() -> Unit)? = null

  @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
  suspend fun show(activity: Activity, valid: () -> Boolean): NativeBunker? {
    if (Looper.myLooper() != Looper.getMainLooper() || pending != null || !valid()) {
      throw NativeVault.Error("AUTHORIZATION_DENIED")
    }
    return suspendCancellableCoroutine { continuation ->
      val layout = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(24, 16, 24, 16)
      }
      layout.addView(TextView(activity).apply {
        text = "Enter the connection link from your remote signer. Hypergolic stores its connection credentials on this device."
        textSize = 16f
      })
      val entry = EditText(activity).apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        hint = "Bunker connection URL"
        isSaveEnabled = false
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        if (Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        if (Build.VERSION.SDK_INT >= 29) importantForContentCapture = View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS
        filters = arrayOf(android.text.InputFilter.LengthFilter(8192))
      }
      layout.addView(entry)
      val error = TextView(activity)
      layout.addView(error)
      val dialog = AlertDialog.Builder(activity)
        .setTitle("Connect remote signer")
        .setView(layout)
        .setPositiveButton("Connect signer", null)
        .setNegativeButton("Cancel", null)
        .create()
      var completed = false
      lateinit var expire: Runnable
      lateinit var poll: Runnable
      fun finish(key: NativeBunker?) {
        if (completed) { key?.close(); return }
        completed = true
        pending = null
        main.removeCallbacks(expire)
        main.removeCallbacks(poll)
        entry.text?.let { value ->
          for (index in 0 until value.length) value.replace(index, index + 1, "0")
          value.clear()
        }
        dialog.setOnDismissListener(null)
        dialog.dismiss()
        if (continuation.isActive) continuation.resume(key, onCancellation = { key?.close() }) else key?.close()
      }
      expire = Runnable { finish(null) }
      poll = Runnable {
        if (!valid()) finish(null) else main.postDelayed(poll, 200)
      }
      pending = { finish(null) }
      continuation.invokeOnCancellation { main.post { finish(null) } }
      dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      dialog.setOnCancelListener { finish(null) }
      dialog.setOnDismissListener { finish(null) }
      dialog.show()
      dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener { finish(null) }
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).apply {
        filterTouchesWhenObscured = true
        setOnTouchListener { _, event ->
          event.flags and (MotionEvent.FLAG_WINDOW_IS_OBSCURED or MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) != 0
        }
        setOnClickListener {
          if (!valid() || activity.isFinishing || activity.isDestroyed) { finish(null); return@setOnClickListener }
          var chars: CharArray? = null
                    try {
            val value = entry.text ?: throw IllegalArgumentException()
            chars = CharArray(value.length)
            value.getChars(0, value.length, chars, 0)
            finish(NativeBunker.parse(chars))
          } catch (_: Exception) {
            error.text = "Enter a valid bunker connection URL."
          } finally {
            chars?.fill('\u0000')
          }
        }
      }
      main.postDelayed(expire, 600_000)
      main.postDelayed(poll, 200)
    }
  }

  fun cancellation(): () -> Unit {
    val captured = pending
    return {
      if (Looper.myLooper() == Looper.getMainLooper()) captured?.invoke()
      else main.post { captured?.invoke() }
      Unit
    }
  }
  fun cancel() = cancellation().invoke()
}
