package org.nostrocket.hypergolic.identityowner

import android.app.Activity
import android.os.SystemClock
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

/** Native adapter reuses the established authentication, one-use authority and secure Canvas reveal. */
class NativeVaultIdentityActions(private val owner: Any, private val records: Records) {
  interface Records {
    fun snapshot(): String
    fun backup(pubkey: String, vault: String, revision: Long): CharArray
    fun erase(pubkey: String, vault: String, revision: Long)
  }

  private val prompt = SystemDeletionAuthentication()
  private val panel = NativeBackupPanel()

  private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it.toInt() and 255) }

  private fun read(): DeletionAuthority.Inventory {
    val raw = records.snapshot()
    val value = JSONObject(raw)
    val identities = mutableMapOf<String, String>()
    val rows = value.getJSONArray("identities")
    for (index in 0 until rows.length()) {
      val pubkey = rows.getJSONObject(index).getString("pubkey")
      identities[pubkey] = digest(raw + pubkey)
    }
    return DeletionAuthority.Inventory(value.getString("vaultId"), value.getLong("revision"),
      value.getString("selectedPubkey"), digest(raw), identities)
  }

  private val authority = DeletionAuthority(::read, SystemClock::elapsedRealtime) {
    val bytes = ByteArray(32)
    SecureRandom().nextBytes(bytes)
    bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
  }.apply {
    activate()
    updateForeground(true)
  }

  private fun owned() {
    if (!NativeIdentityOwnerAccess.owns(owner)) throw DeletionAuthority.Denied()
  }

  fun available(activity: Activity): Boolean {
    owned()
    return prompt.available(activity)
  }

  fun foreground(value: Boolean) {
    authority.updateForeground(value)
    if (!value) {
      prompt.cancel()
      panel.cancel()
    }
  }

  fun cancel() {
    authority.vaultWillMutate()
    prompt.cancel()
    panel.cancel()
  }

  suspend fun backup(activity: Activity, pubkey: String, vault: String, revision: Long) {
    owned()
    val current = read()
    if (current.vault != vault || current.revision != revision || current.selected != pubkey) {
      throw DeletionAuthority.Denied()
    }
    val session = authority.beginSettings(pubkey, revision)
    val attempt = authority.beginBackup(session, pubkey, pubkey, revision)
    var secret: CharArray? = null
    try {
      val accepted = withTimeout(DeletionAuthority.AUTH_MILLIS) {
        prompt.authenticate(activity, authority.prompt(attempt)) {
          NativeIdentityOwnerAccess.owns(owner) && authority.canPresent(attempt)
        }
      }
      val lease = authority.completeBackup(attempt, accepted)
      try {
        secret = withContext(Dispatchers.Default) {
          authority.readBackup(lease) { target, _ -> records.backup(target, vault, revision) }
        }
        panel.show(activity, secret!!, authority, lease)
      } finally {
        secret?.fill('\u0000')
        authority.closeBackup(lease)
      }
    } finally {
      authority.cancelAttempt(attempt)
      authority.endSettings(session)
      prompt.cancel()
      panel.cancel()
    }
  }

  suspend fun delete(activity: Activity, pubkey: String, vault: String, revision: Long, localOnly: Boolean = false) {
    owned()
    val current = read()
    if (current.vault != vault || current.revision != revision) throw DeletionAuthority.Denied()
    val session = authority.beginSettings(current.selected, revision)
    val attempt = if (localOnly) authority.beginLocalRemoval(session, pubkey, current.selected, revision)
      else authority.begin(session, pubkey, current.selected, revision)
    try {
      val accepted = withTimeout(DeletionAuthority.AUTH_MILLIS) {
        prompt.authenticate(activity, authority.prompt(attempt)) {
          NativeIdentityOwnerAccess.owns(owner) && authority.canPresent(attempt)
        }
      }
      val grant = authority.complete(attempt, accepted)
      withContext(Dispatchers.Default) {
        authority.erase(session, pubkey, grant) { target -> records.erase(target, vault, revision) }
      }
    } finally {
      authority.cancelAttempt(attempt)
      authority.endSettings(session)
      prompt.cancel()
      panel.cancel()
    }
  }
}
