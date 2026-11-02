package org.nostrocket.hypergolic.host

import android.app.Activity
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.app.ActivityManager
import android.os.Build
import android.os.PowerManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.ValueCallback
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** One system selection; provider authority ends at the selected URI, not the whole library. */
internal object SelectedFilePicker {
  private const val CODE = 24871
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private class Pending(val activity: Activity, val generation: String, val live: () -> Boolean,
    val callback: ValueCallback<Array<Uri>>, val deadline: Long) {
    @Volatile var cancelled = false
    val stream = AtomicReference<java.io.InputStream?>()
    var awaitingSystem = true
    var result: Uri? = null
    var receiver: BroadcastReceiver? = null
  }
  private val reading = AtomicBoolean(false)
  private var pending: Pending? = null
  private var foreground = false
  fun choose(activity: Activity?, generation: String, live: () -> Boolean, callback: ValueCallback<Array<Uri>>) {
    if (activity == null || !foreground || !live() || pending != null || reading.get()) { callback.onReceiveValue(null); return }
    val entry = Pending(activity, generation, live, callback, SystemClock.elapsedRealtime() + 600_000)
    pending = entry
    if (!bindLifetime(entry)) { cancel(); return }
    main.postDelayed({ if (pending === entry) cancel() }, 600_000)
    try {
      // Avoid guest-supplied chooser intents, cameras, directories and persistent grants.
      android.widget.Toast.makeText(activity, "Supported photos are prepared as PNG without resizing. Uploading needs separate approval.", android.widget.Toast.LENGTH_LONG).show()
      activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"; putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
      }, CODE)
    } catch (_: Exception) { cancel() }
  }
  fun result(activity: Activity, code: Int, result: Int, data: Intent?) {
    if (code != CODE) return
    val entry = pending ?: return
    entry.awaitingSystem = false
    val uri = data?.data
    if (activity !== entry.activity || result != Activity.RESULT_OK || uri == null || data.clipData?.itemCount?.let {it != 1} == true ||
      uri.scheme != "content" || uri.authority.isNullOrEmpty() || uri.query != null || uri.fragment != null ||
      SystemClock.elapsedRealtime() >= entry.deadline || !entry.live()) { cancel(); return }
    // Providers can return URIs for files our own app can access; never accept our UID.
    val provider = activity.packageManager.resolveContentProvider(uri.authority!!, 0)
    if (provider == null || provider.applicationInfo.uid == activity.applicationInfo.uid ||
      activity.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != android.content.pm.PackageManager.PERMISSION_GRANTED) { cancel(); return }
    entry.result = uri
    if (foreground) prepare(entry)
    else main.postDelayed({ if (pending === entry && !foreground) cancel() }, 5_000)
  }
  fun foreground(active: Boolean) {
    foreground = active
    if (!active) {
      SelectedFileProvider.revokeAll()
      // An outstanding external system chooser may return a newly selected file on resume.
      // It revives no upload grants. A returned/processing selection is cancelled on background.
      if (pending?.awaitingSystem == false) cancel()
    } else pending?.let { if (!it.awaitingSystem && it.result != null) prepare(it) }
  }
  fun revoke(generation: String) { SelectedFileProvider.revoke(generation); if (pending?.generation == generation) cancel() }
  fun cancel() {
    val entry = pending; pending = null
    entry?.cancelled = true
    entry?.let { unbindLifetime(it) }
    try {entry?.stream?.getAndSet(null)?.close()} catch (_: Exception) {}
    entry?.callback?.onReceiveValue(null)
  }
  private fun bindLifetime(entry: Pending): Boolean {
    val context = entry.activity.applicationContext
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (pending === entry && intent?.action in setOf(Intent.ACTION_CLOSE_SYSTEM_DIALOGS, Intent.ACTION_SCREEN_OFF)) cancel()
      }
    }
    return try {
      val filter = IntentFilter().apply {addAction(Intent.ACTION_CLOSE_SYSTEM_DIALOGS); addAction(Intent.ACTION_SCREEN_OFF)}
      if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      else context.registerReceiver(receiver, filter)
      entry.receiver = receiver
      watchTask(entry)
      true
    } catch (_: Exception) {false}
  }
  private fun unbindLifetime(entry: Pending) {
    val receiver = entry.receiver ?: return; entry.receiver = null
    try {entry.activity.applicationContext.unregisterReceiver(receiver)} catch (_: Exception) {}
  }
  private fun watchTask(entry: Pending) {
    main.postDelayed({
      if (pending !== entry || !entry.awaitingSystem) return@postDelayed
      try {
        val power = entry.activity.getSystemService(PowerManager::class.java)
        if (power == null || !power.isInteractive) {cancel(); return@postDelayed}
        if (Build.VERSION.SDK_INT >= 32) {
          val manager = entry.activity.getSystemService(ActivityManager::class.java)
          val task = manager?.appTasks?.map {it.taskInfo}?.singleOrNull {it.taskId == entry.activity.taskId}
          if (task == null || !task.isVisible) {cancel(); return@postDelayed}
        }
        watchTask(entry)
      } catch (_: Exception) {cancel()}
    }, 200)
  }
  private fun prepare(entry: Pending) {
    val uri = entry.result ?: return
    entry.result = null
    if (!reading.compareAndSet(false, true)) {cancel(); return}
    main.postDelayed({if (pending === entry) cancel()}, 30_000)
    worker.execute {
      var original: ByteArray? = null
      try {
        val resolver = entry.activity.contentResolver
        resolver.openInputStream(uri)?.use { input ->
          entry.stream.set(input)
          val buffer = ByteArray(NativeUploadAuthority.MAX_BYTES + 1); var cursor = 0
          try {
            while (!entry.cancelled) {
              val count = input.read(buffer, cursor, minOf(64 * 1024, buffer.size - cursor))
              if (count < 0) {original = buffer.copyOf(cursor); break}
              if (count == 0 || count > NativeUploadAuthority.MAX_BYTES - cursor) throw IllegalArgumentException()
              cursor += count
            }
          } finally {buffer.fill(0); entry.stream.compareAndSet(input, null)}
        }
        val bytes = original ?: throw IllegalArgumentException()
        // Failed photos never become unchanged attachments.
        val prepared = UploadPhotoPreparation.prepare(bytes) ?: throw IllegalArgumentException()
        main.post {
          try {
            if (pending !== entry || !foreground || !entry.live() || SystemClock.elapsedRealtime() >= entry.deadline) return@post
            val output = SelectedFileProvider.stage(entry.activity, entry.generation, prepared.bytes(), prepared.mimeType(), entry.live)
            pending = null; unbindLifetime(entry); entry.callback.onReceiveValue(output?.let {arrayOf(it)})
          } finally {prepared.bytes().fill(0)}
        }
      } catch (_: Exception) { main.post {
        if (pending === entry) {
          val show = foreground && entry.live(); cancel()
          if (show) android.widget.Toast.makeText(entry.activity, "File could not be prepared. No file was shared.", android.widget.Toast.LENGTH_LONG).show()
        }
      } }
      finally {original?.fill(0); reading.set(false)}
    }
  }
}
