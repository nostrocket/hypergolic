package org.nostrocket.hypergolic.identityowner

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The only secret-bearing UI is a native Canvas; no text, accessibility or bridge value carries it. */
internal class NativeBackupPanel {
  private val main = Handler(Looper.getMainLooper())
  private class Pending(val valid: () -> Boolean, val close: () -> Unit)
  private var pending: Pending? = null // Main thread only.

  private class SecretView(context: Context, private val secret: CharArray, private val valid: () -> Boolean) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; typeface = Typeface.MONOSPACE }
    init {
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
      if (Build.VERSION.SDK_INT >= 29) importantForContentCapture = IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS
      isSaveEnabled = false
      isLongClickable = false
      filterTouchesWhenObscured = true
      setBackgroundColor(Color.rgb(24, 22, 20))
    }
    fun clear() { secret.fill('\u0000'); invalidate() }
    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      if (!valid() || !hasWindowFocus()) return
      val scale = resources.displayMetrics.density
      // Fixed 21-character lines keep the exact 63-character nsec legible without selectable text.
      paint.textSize = minOf(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 18f, resources.displayMetrics), (width - 32 * scale) / 13f)
      for (line in 0..2) canvas.drawText(secret, line * 21, 21, 16 * scale, (28 + line * 30) * scale, paint)
    }
  }

  suspend fun show(activity: Activity, secret: CharArray, authority: DeletionAuthority, lease: DeletionAuthority.BackupLease) {
    try {
      withContext(Dispatchers.Main.immediate) {
        if (pending != null || activity.isFinishing || activity.isDestroyed || secret.size != 63 || !authority.canReveal(lease)) throw DeletionAuthority.Denied()
        suspendCancellableCoroutine { continuation ->
          var failure: Exception? = null
          lateinit var request: Pending
          lateinit var tick: Runnable
          val view = SecretView(activity, secret) { authority.canReveal(lease) }
          val dialog = object : Dialog(activity) {
            override fun onWindowFocusChanged(hasFocus: Boolean) {
              super.onWindowFocusChanged(hasFocus)
              if (!hasFocus) request.close() else view.invalidate()
            }
            override fun onStop() { view.clear(); super.onStop() }
          }
          request = Pending({ authority.canReveal(lease) }) {
            if (pending === request) {
              pending = null
              authority.closeBackup(lease)
              view.clear()
              main.removeCallbacks(tick)
              dialog.setOnDismissListener(null)
              dialog.dismiss()
              if (continuation.isActive) {
                if (failure != null) continuation.resumeWithException(DeletionAuthority.Denied()) else continuation.resume(Unit)
              }
            }
          }
          tick = Runnable {
            if (pending === request) {
              if (!request.valid()) request.close() else main.postDelayed(tick, 200)
            }
          }
          pending = request
          continuation.invokeOnCancellation { main.post { request.close() } }
          try {
            val scale = activity.resources.displayMetrics.density
            val layout = LinearLayout(activity).apply {
              orientation = LinearLayout.VERTICAL
              setPadding((20 * scale).toInt(), (20 * scale).toInt(), (20 * scale).toInt(), (12 * scale).toInt())
              setBackgroundColor(Color.rgb(24, 22, 20))
              filterTouchesWhenObscured = true
            }
            fun label(value: String, size: Float) = TextView(activity).apply { text = value; textSize = size; setTextColor(Color.WHITE) }
            layout.addView(label("Write down your private key", 22f))
            layout.addView(label("Anyone with this key controls your identity. Keep it private. This reveal closes after one minute.", 16f))
            layout.addView(view, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (112 * scale).toInt()))
            layout.addView(Button(activity).apply {
              text = "Hide private key"
              filterTouchesWhenObscured = true
              setOnClickListener { request.close() }
            })
            dialog.setContentView(layout)
            dialog.setCanceledOnTouchOutside(false)
            dialog.setOnDismissListener { request.close() }
            val window = dialog.window ?: throw DeletionAuthority.Denied()
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            if (!continuation.isActive || !request.valid()) request.close()
            else {
              dialog.show()
              window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
              main.post(tick)
            }
          } catch (error: Exception) { failure = error; request.close() }
        }
      }
    } finally { secret.fill('\u0000'); authority.closeBackup(lease) }
  }

  /** Revocation precedes this cleanup; native lifecycle callers clear synchronously on the UI thread. */
  fun cancel() {
    val cleanup = Runnable { val request = pending; if (request != null && !request.valid()) request.close() }
    if (Looper.myLooper() == Looper.getMainLooper()) cleanup.run() else main.post(cleanup)
  }
}
