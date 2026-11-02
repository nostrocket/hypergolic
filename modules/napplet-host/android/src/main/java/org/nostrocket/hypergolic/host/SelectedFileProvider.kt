package org.nostrocket.hypergolic.host

import android.content.ContentProvider
import android.content.ContentValues
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Binder
import android.os.ParcelFileDescriptor
import android.os.Process
import android.provider.OpenableColumns
import java.util.UUID
import java.io.File

/** App-private copied selections, never third-party picker URIs or original filesystem paths. */
class SelectedFileProvider : ContentProvider() {
  override fun onCreate(): Boolean {context?.let { runCatching { stagingRoot(it) } }; return true}
  override fun getType(uri: Uri): String? = selection(uri)?.mime
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? {
    val entry = selection(uri) ?: return null
    val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    return MatrixCursor(columns).apply { addRow(columns.map<String, Any?> { when (it) {OpenableColumns.DISPLAY_NAME -> entry.name; OpenableColumns.SIZE -> entry.length; else -> null} }.toTypedArray()) }
  }
  override fun openAssetFile(uri: Uri, mode: String): AssetFileDescriptor {
    val length = selection(uri)?.length ?: throw java.io.FileNotFoundException()
    return AssetFileDescriptor(openFile(uri, mode), 0, length.toLong())
  }
  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw java.io.FileNotFoundException()
    return synchronized(entries) {
      val entry = selection(uri) ?: throw java.io.FileNotFoundException()
      // Chromium probes descriptors for metadata before reading. Seekable private files
      // avoid blocked pipe writers; total opens are bounded per selection.
      if (++entry.opens > 128) throw java.io.FileNotFoundException()
      ParcelFileDescriptor.open(entry.file, ParcelFileDescriptor.MODE_READ_ONLY)
    }
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
  private fun selection(uri: Uri): Selection? {
    if (Binder.getCallingUid() != Process.myUid() || uri.scheme != "content" || uri.authority != context?.packageName + ".selected-files" || uri.pathSegments.size != 1 || uri.query != null || uri.fragment != null) return null
    synchronized(entries) {
      val entry = entries[uri.lastPathSegment] ?: return null
      if (android.os.SystemClock.elapsedRealtime() >= entry.deadline || !entry.live()) { entries.remove(uri.lastPathSegment)?.file?.delete(); return null }
      return entry
    }
  }
  private class Selection(val generation: String, val file: File, val length: Int, val name: String, val mime: String,
    val live: () -> Boolean, val deadline: Long) {var opens = 0}
  companion object {
    private val entries = mutableMapOf<String, Selection>()
    private var root: File? = null
    private fun stagingRoot(context: android.content.Context): File = synchronized(entries) {
      root ?: File(context.cacheDir, "hypergolic-selected-files").also {
        it.deleteRecursively(); require(it.mkdirs()); root = it
      }
    }
    fun stage(context: android.content.Context, generation: String, bytes: ByteArray, mime: String, live: () -> Boolean): Uri? = synchronized(entries) {
      revoke(generation)
      if (bytes.size > NativeUploadAuthority.MAX_BYTES || entries.size >= 2 || !live()) return null
      val token = UUID.randomUUID().toString()
      val extension = when (mime) {"image/png" -> ".png"; "audio/wav" -> ".wav"; "audio/mpeg" -> ".mp3"; "video/mp4" -> ".mp4"; "application/pdf" -> ".pdf"; "application/zip" -> ".zip"; "text/plain" -> ".txt"; else -> ".bin"}
      val file = runCatching { File(stagingRoot(context), token) }.getOrNull() ?: return null
      try {file.outputStream().use {it.write(bytes)}} catch (_: Exception) {file.delete(); return null}
      entries[token] = Selection(generation, file, bytes.size, "Selected file$extension", mime, live, android.os.SystemClock.elapsedRealtime() + 600_000)
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ synchronized(entries) { entries.remove(token)?.file?.delete() } }, 600_000)
      Uri.Builder().scheme("content").authority(context.packageName + ".selected-files").appendPath(token).build()
    }
    fun revoke(generation: String) = synchronized(entries) {
      entries.entries.removeAll { if (it.value.generation == generation) {it.value.file.delete(); true} else false }
    }
    fun revokeAll() = synchronized(entries) {entries.values.forEach {it.file.delete()}; entries.clear()}
  }
}
