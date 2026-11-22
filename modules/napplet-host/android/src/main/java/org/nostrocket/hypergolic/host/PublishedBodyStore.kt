package org.nostrocket.hypergolic.host

import android.database.sqlite.SQLiteDatabase
import android.os.ParcelFileDescriptor
import androidx.annotation.Keep
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONObject

/** Native ownership of published bytes between signed lookup, account cache, and the one-use registry. */
@Keep
internal object PublishedBodyStore {
  private const val maximumBody = 20 * 1024 * 1024
  private const val maximumReserved = 96 * 1024 * 1024
  private val hashPattern = Regex("[a-f0-9]{64}")
  private data class Entry(val file: File, var length: Int = 0, var user: String? = null, var verified: Boolean = false)
  private val entries = mutableMapOf<String, Entry>()
  private var directory: File? = null
  private var foreground = false
  private external fun validEnvelope(bytes: ByteArray): Boolean

  @Synchronized fun configure(cache: File) {
    if (directory != null) return
    System.loadLibrary("hypergolic_body")
    val root = File(cache, "published-body-v1")
    check(root.mkdirs() || root.isDirectory)
    root.listFiles()?.forEach { if (it.isFile) it.delete() }
    directory = root
  }

  @Synchronized fun foreground(value: Boolean) { foreground = value; if (!value) clear() }
  @Synchronized fun clear() { entries.keys.toList().forEach(::release) }
  @Synchronized fun release(token: String) { entries.remove(token)?.let { SQLiteDatabase.deleteDatabase(it.file) } }

  @Synchronized fun issue(): String {
    check(foreground && entries.size < 64)
    val token = UUID.randomUUID().toString()
    entries[token] = Entry(File(checkNotNull(directory), "$token.db"))
    return token
  }

  // Each token has one SQLite file. Its single write completes and closes before the next owner opens it.
  @Synchronized fun database(token: String, user: String, length: Int): String {
    require(hashPattern.matches(user))
    val entry = reserve(token, length)
    check(entry.user == null || entry.user == user)
    entry.user = user
    return entry.file.absolutePath
  }

  @Synchronized private fun reserve(token: String, length: Int): Entry {
    val entry = checkNotNull(entries[token])
    check(foreground && length in 1..maximumBody)
    if (entry.length == 0) {
      check(entries.values.sumOf { it.length } + length <= maximumReserved)
      SQLiteDatabase.openOrCreateDatabase(entry.file, null).use { db ->
        db.rawQuery("PRAGMA journal_mode=DELETE", null).use { check(it.moveToFirst()) }
        db.execSQL("CREATE TABLE payload (id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL CHECK(typeof(body)='blob' AND length(body)=$length))")
      }
      entry.length = length
    }
    check(entry.length == length)
    return entry
  }

  private fun verify(bytes: ByteArray, hash: String): Int {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    if (!hashPattern.matches(hash) || !digest.indices.all { i ->
        val value = digest[i].toInt() and 255
        hash[i * 2].digitToInt(16) == (value shr 4) && hash[i * 2 + 1].digitToInt(16) == (value and 15)
      }) return -2
    return if (validEnvelope(bytes)) bytes.size else -3
  }

  fun retainDownload(token: String, hash: String, bytes: ByteArray): Int {
    try {
      val entry = reserve(token, bytes.size)
      val result = verify(bytes, hash)
      if (result < 0) return result
      SQLiteDatabase.openDatabase(entry.file.path, null, SQLiteDatabase.OPEN_READWRITE).use {
        it.execSQL("INSERT INTO payload (id,body) VALUES (1,?)", arrayOf(bytes))
      }
      synchronized(this) { check(entries[token] === entry); entry.verified = true }
      return result
    } finally { bytes.fill(0) }
  }

  private fun bytes(entry: Entry): ByteArray {
    SQLiteDatabase.openDatabase(entry.file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
      db.compileStatement("SELECT body FROM payload WHERE id=1").use { sql ->
        val fd = checkNotNull(sql.simpleQueryForBlobFileDescriptor())
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { input ->
          val bytes = ByteArray(entry.length)
          java.io.DataInputStream(input).readFully(bytes)
          check(input.read() == -1)
          return bytes
        }
      }
    }
  }

  fun verifyCached(token: String, hash: String): Int {
    val entry = synchronized(this) { checkNotNull(entries[token]).also { check(it.user != null && it.length > 0) } }
    val data = bytes(entry)
    try {
      val result = verify(data, hash)
      synchronized(this) { check(entries[token] === entry); entry.verified = result > 0 }
      return result
    } finally { data.fill(0) }
  }

  fun stage(token: String, json: String): String? {
    val c = JSONObject(json)
    val entry = synchronized(this) { checkNotNull(entries[token]).also { check(it.verified && it.user == c.getString("user")) } }
    val data = bytes(entry)
    try {
      return synchronized(this) {
        check(entries[token] === entry && foreground)
        PublishedArtifactTransfer.INSTANCE.stageOwned(data, c.getString("sessionId"), c.getString("publisher"),
          c.getString("identifier"), c.getString("eventId"), c.getString("aggregateHash"), c.getString("htmlHash"),
          if (c.has("title")) c.getString("title") else null)
      }
    } finally { data.fill(0) }
  }
}
