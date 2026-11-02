package org.nostrocket.hypergolic.signercore

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.kotlin.AppContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicReference
import org.nostrocket.hypergolic.identityowner.NativeIdentityOwnerAccess
import org.nostrocket.hypergolic.host.NativeSignerRelay

/** Native connection entry, handshake and original candidate deadline. No JS connection URI or approval flag. */
internal class NativeConnectionActions(
  private val owner: AppContext,
  private val session: NativeVaultSession,
  private val records: () -> NativeVault,
  private val active: () -> Boolean,
  private val handoffs: NativeHandoffController,
) {
  private val main = Handler(Looper.getMainLooper())
  private val entryPanel = NativeConnectionPanel()
  private val confirmation = NativeConfirmationPanel()
  @Volatile private var expiry: Runnable? = null
  private class Attempt {
    lateinit var operation: NativeRemoteOperation
    lateinit var authorization: NativeHandoffController.Authorization
  }
  private val pending = AtomicReference<Attempt?>(null)

  private fun correlation(attempt: String) {
    if (attempt.length !in 1..128) throw NativeVault.Error("AUTHORIZATION_DENIED")
    NativeEvent.quote(attempt)
  }

  private fun attempt(storage: NativeVault, vault: String, revision: Long, epoch: Long,
    correlation: String, purpose: String, deadline: Long): Attempt {
    val value = Attempt()
    val captured = {
      pending.get() === value && runCatching {
        synchronized(session.lock) {
          session.requireAction(epoch) { NativeIdentityOwnerAccess.owns(owner) }
          storage.assertRevision(owner, vault, revision)
        }
        true
      }.getOrDefault(false)
    }
    value.authorization = handoffs.authorization(
      NativeHandoffController.Binding.Preparation(vault, revision, correlation, purpose), epoch, deadline,
      NativeHandoffController.Checks({ active() && captured() }, captured, { finish(value, false) }),
    )
    value.operation = NativeRemoteOperation(deadline, object : NativeRemoteOperation.Guard {
      override fun check() {
        if (!value.authorization.receive()) throw NativeVault.Error("AUTHORIZATION_DENIED")
      }
      override fun execute() {
        if (!value.authorization.execute()) throw NativeVault.Error("AUTHORIZATION_DENIED")
      }
      override fun beforeSigningSend() { throw NativeVault.Error("SIGNER_UNSUPPORTED") }
    })
    if (!pending.compareAndSet(null, value)) {
      value.operation.close()
      throw NativeVault.Error("AUTHORIZATION_DENIED")
    }
    return value
  }

  private fun finish(value: Attempt, completed: Boolean) {
    if (!pending.compareAndSet(value, null)) return
    value.operation.close()
    if (completed) handoffs.complete(value.authorization) else handoffs.cancel(value.authorization)
  }

  private fun schedule(handle: String, deadline: Long, refresh: Boolean) {
    expiry?.let(main::removeCallbacks)
    val timeout = Runnable {
      synchronized(session.lock) {
        runCatching {
          if (refresh) records().cancelRefresh(owner, handle) else records().cancelRemote(owner, handle)
        }
      }
    }
    expiry = timeout
    main.postDelayed(timeout, (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0))
  }

  suspend fun prepare(vault: String, revision: Long, epoch: Long, attempt: String): String? {
    correlation(attempt)
    val storage = synchronized(session.lock) { records().also { it.assertRevision(owner, vault, revision) } }
    val activity = owner.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
    val entry = entryPanel.show(activity) { active() && session.activated && session.epoch == epoch } ?: return null
    var binding: NativeRemoteBinding? = null
    var current: Attempt? = null
    var completed = false
    try {
      current = attempt(storage, vault, revision, epoch, attempt, "connect", entry.deadline)
      val operation = current.operation
      val authorization = current.authorization
      binding = NativeRemoteBinding(NativeSigningKey(), entry.peer, entry.relays)
      val connected = binding
      val result = withContext(Dispatchers.IO) {
        NativeNip46Client(connected, operation).authorization(authorization).use { client ->
          client.connect(entry.secret) to client.switchRelays()
        }
      }
      operation.execute()
      val saved = NativeRemoteBinding(connected.client, connected.peer, result.second)
      binding = saved
      val prepared = synchronized(session.lock) {
        session.require(epoch, active)
        storage.prepareRemote(owner, result.first, saved, entry.deadline, vault, revision)
      }
      binding = null
      schedule(JSONObject(prepared).getString("handle"), entry.deadline, false)
      completed = true
      return prepared
    } finally {
      current?.let { finish(it, completed) }
      binding?.close()
      entry.close()
    }
  }

  suspend fun prepareRefresh(pubkey: String, vault: String, revision: Long, epoch: Long, attempt: String): String? {
    correlation(attempt)
    val storage = synchronized(session.lock) { records() }
    val saved = synchronized(session.lock) { storage.savedRemote(owner, pubkey, vault, revision) }
    var proposed: NativeRemoteBinding? = null
    var current: Attempt? = null
    var completed = false
    try {
      val activity = owner.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
      var deadline = 0L
      val detail = "Identity:\n$pubkey\n\nSigner peer:\n${saved.peer}\n\nCheck these saved signer relays:\n${saved.relays.joinToString("\n")}"
      if (!confirmation.confirm(activity, "Check signer relay changes?", detail, "Check relays", onAccepted = {
        deadline = SystemClock.elapsedRealtime() + 120_000L
      }) { active() && session.activated && session.epoch == epoch }) throw NativeVault.Error("AUTHORIZATION_DENIED")
      current = attempt(storage, vault, revision, epoch, attempt, "refresh", deadline)
      val operation = current.operation
      val authorization = current.authorization
      val budget = NativeSignerRelay.Budget.forRefresh()
      val changed = withContext(Dispatchers.IO) {
        NativeNip46Client(saved, operation, budget).authorization(authorization).use { client ->
          client.publicKey(pubkey)
          client.switchRelays()
        }
      }
      operation.execute()
      if (changed == saved.relays) {
        confirmation.confirm(activity, "No relay changes", "The saved signer returned the same validated relay list.", "Done") {
          active() && session.activated && session.epoch == epoch && SystemClock.elapsedRealtime() < deadline
        }
        completed = true
        return null
      }
      proposed = NativeRemoteBinding(saved.client.copy(), saved.peer, changed)
      val verified = proposed
      withContext(Dispatchers.IO) {
        NativeNip46Client(verified, operation, budget).authorization(authorization).use { client ->
          client.publicKey(pubkey)
        }
      }
      operation.execute()
      val prepared = synchronized(session.lock) {
        session.require(epoch, active)
        storage.prepareRefresh(owner, pubkey, verified, deadline, vault, revision)
      }
      proposed = null
      schedule(JSONObject(prepared).getString("handle"), deadline, true)
      completed = true
      return prepared
    } finally {
      current?.let { finish(it, completed) }
      proposed?.close()
      saved.close()
    }
  }

  suspend fun commit(handle: String, vault: String, revision: Long, epoch: Long, refresh: Boolean): String {
    val storage = synchronized(session.lock) { records() }
    val detail = synchronized(session.lock) {
      if (refresh) storage.refreshReview(owner, handle, vault, revision) else storage.remoteReview(owner, handle, vault, revision)
    }
    val activity = owner.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
    val title = if (refresh) "Update signer relays?" else "Connect and use this signer?"
    val button = if (refresh) "Use these relays" else "Connect and use signer"
    if (!confirmation.confirm(activity, title, detail, button) {
      active() && session.activated && session.epoch == epoch &&
        if (refresh) storage.refreshActive(owner, handle, vault, revision) else storage.remoteActive(owner, handle, vault, revision)
    }) {
      if (refresh) storage.cancelRefresh(owner, handle) else storage.cancelRemote(owner, handle)
      throw NativeVault.Error("AUTHORIZATION_DENIED")
    }
    return synchronized(session.lock) {
      session.require(epoch, active)
      val result = if (refresh) storage.commitRefresh(owner, handle, vault, revision) else storage.commitRemote(owner, handle, vault, revision)
      expiry?.let(main::removeCallbacks)
      expiry = null
      result
    }
  }

  fun cancellation(): () -> Unit {
    val attempt = pending.get()
    val timer = expiry
    val cancelEntry = entryPanel.cancellation()
    val cancelConfirmation = confirmation.cancellation()
    return {
      if (expiry === timer) expiry = null
      timer?.let(main::removeCallbacks)
      attempt?.let { finish(it, false) }
      cancelEntry()
      cancelConfirmation()
    }
  }
  fun cancel() = cancellation().invoke()
}
