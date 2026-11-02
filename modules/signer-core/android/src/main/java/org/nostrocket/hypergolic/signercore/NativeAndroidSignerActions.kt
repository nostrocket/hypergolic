package org.nostrocket.hypergolic.signercore

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.kotlin.AppContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.nostrocket.hypergolic.host.NativeSigningSourceFacade
import org.nostrocket.hypergolic.identityowner.NativeIdentityOwnerAccess
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Native picker, exact Activity result and shared original-operation Resume. No JS approval or package authority. */
internal class NativeAndroidSignerActions(
  private val owner: AppContext,
  private val session: NativeVaultSession,
  private val records: () -> NativeVault,
  private val active: () -> Boolean,
  private val handoffs: NativeHandoffController,
) {
  class SigningRequest(val kind: String, val token: String, val event: NativeEvent, val vault: String,
    val revision: Long, val epoch: Long, val deadline: Long, val source: NativeSigningSourceFacade.Capture,
    val onDispatch: () -> Unit = {})
  private class Running(val authorization: NativeHandoffController.Authorization, val signing: SigningRequest?, val activity: Activity) {
    @Volatile var binding: NativeAndroidSignerBinding? = null
    @Volatile var requestId: String? = null
    @Volatile var dispatched = false
    @Volatile var stopRequest: Runnable? = null
  }
  private val main = Handler(Looper.getMainLooper())
  private val controller = NativeAndroidSignerActivityController(owner) { active() && current.get()?.authorization?.receive() == true }
  private val confirmation = NativeConfirmationPanel()
  private val current = AtomicReference<Running?>(null)
  @Volatile private var expiry: Runnable? = null

  private fun captured(epoch: Long, preparing: Boolean = false): Boolean = runCatching {
    synchronized(session.lock) {
      if (preparing) session.requireAction(epoch) { NativeIdentityOwnerAccess.owns(owner) }
      else session.require(epoch) { NativeIdentityOwnerAccess.owns(owner) }
    }; true
  }.getOrDefault(false)

  private fun episode(binding: NativeHandoffController.Binding, epoch: Long, deadline: Long,
    storage: NativeVault, activity: Activity, signing: SigningRequest? = null): Running {
    lateinit var row: Running
    val vault = (binding as? NativeHandoffController.Binding.Preparation)?.vault ?: signing!!.vault
    val revision = (binding as? NativeHandoffController.Binding.Preparation)?.revision ?: signing!!.revision
    fun bound(): Boolean = runCatching {
      if (current.get() !== row || activity.isFinishing || activity.isDestroyed) return@runCatching false
      row.binding?.let { NativeAndroidSignerInventory.requireCurrent(activity, it) }
      synchronized(session.lock) {
        if (signing == null) session.requireAction(epoch) { NativeIdentityOwnerAccess.owns(owner) }
        else session.require(epoch) { NativeIdentityOwnerAccess.owns(owner) }
        storage.assertRevision(owner, vault, revision)
      }
      current.get() === row
    }.getOrDefault(false)
    val authorization = handoffs.authorization(binding, epoch, deadline, NativeHandoffController.Checks(
      live = { active() && bound() && (signing == null || signing.source.active()) },
      captured = { bound() && (signing == null || signing.source.handoffActive()) },
      cancel = {
        val stop = row.stopRequest
        if (current.compareAndSet(row, null)) {
          stop?.run()
          signing?.source?.cancelHandoff { NativeSigningSourceFacade.cancel(signing.kind, signing.token) }
        }
      },
    ))
    row = Running(authorization, signing, activity)
    if (!current.compareAndSet(null, row)) throw NativeVault.Error("AUTHORIZATION_DENIED")
    return row
  }

  private fun hook(row: Running) = object : NativeAndroidSignerActivityController.Handoff {
    override fun start(id: String, deadline: Long, binding: NativeAndroidSignerBinding) {
      if (current.get() !== row || !captured(row.authorization.epoch, row.signing == null) || deadline != row.authorization.deadline) throw NativeVault.Error("AUTHORIZATION_DENIED")
      if (row.binding != null && row.binding?.sameInstallation(binding) != true) throw NativeVault.Error("SIGNER_IDENTITY_CHANGED")
      NativeAndroidSignerInventory.requireCurrent(row.activity, binding)
      row.binding = binding
      row.requestId = id
      row.stopRequest = controller.cancellation()
      row.authorization.beginActivity(id)
    }
    override fun current(id: String, deadline: Long): Boolean = current.get() === row && row.requestId == id &&
      row.authorization.activityCurrent(id, deadline)
    override fun dispatched() { row.dispatched = true; row.signing?.onDispatch?.invoke() }
    override fun cancel() { row.authorization.discard() }
  }

  private suspend fun activityReply(row: Running, launch: (NativeAndroidSignerActivityController.Completion) -> Unit): Pair<NativeAndroidSignerBinding, String> =
    suspendCancellableCoroutine { continuation ->
      continuation.invokeOnCancellation { val stop = row.stopRequest; row.authorization.discard(); if (current.compareAndSet(row, null)) stop?.run() }
      try {
        launch(NativeAndroidSignerActivityController.Completion { binding, value, error ->
          if (continuation.isActive) {
            if (error != null || binding == null || value == null) continuation.resumeWithException(NativeVault.Error(error ?: "SIGNER_RESPONSE_INVALID"))
            else continuation.resume(binding to value)
          }
        })
      } catch (failure: Exception) { if (continuation.isActive) continuation.resumeWithException(failure) }
    }

  private suspend fun resume(row: Running) {
    val id = row.requestId ?: throw NativeVault.Error("SIGNER_RESPONSE_INVALID")
    withContext(Dispatchers.IO) { row.authorization.awaitResume(id) }
    if (current.get() !== row || !row.authorization.execute() || !active()) throw NativeVault.Error("AUTHORIZATION_DENIED")
  }

  suspend fun prepare(vault: String, revision: Long, epoch: Long, attempt: String): String? {
    if (attempt.length !in 1..128) throw NativeVault.Error("AUTHORIZATION_DENIED")
    NativeEvent.quote(attempt)
    val storage = synchronized(session.lock) { session.requireAction(epoch, active); records().also { it.assertRevision(owner, vault, revision) } }
    val activity = owner.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
    val deadline = SystemClock.elapsedRealtime() + 120_000L
    val row = episode(NativeHandoffController.Binding.Preparation(vault, revision, attempt, "nip55"), epoch, deadline, storage, activity)
    var completed = false
    try {
      val (binding, pubkey) = activityReply(row) { reply -> controller.choosePublicKeyScoped(activity, owner, deadline, reply, hook(row)) }
      resume(row)
      NativeAndroidSignerInventory.requireCurrent(activity, binding)
      val prepared = synchronized(session.lock) {
        session.requireAction(epoch, active)
        if (SystemClock.elapsedRealtime() >= deadline) throw NativeVault.Error("SIGNER_EXPIRED")
        NativeAndroidSignerInventory.requireCurrent(activity, binding)
        storage.prepareAndroidSigner(owner, pubkey, binding, deadline, vault, revision)
      }
      val handle = JSONObject(prepared).getString("handle")
      expiry?.let(main::removeCallbacks)
      expiry = Runnable { synchronized(session.lock) { runCatching { storage.cancelAndroidSigner(owner, handle) } } }.also {
        main.postDelayed(it, (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0))
      }
      handoffs.complete(row.authorization); completed = true
      return prepared
    } finally {
      if (!completed) row.authorization.discard()
      current.compareAndSet(row, null)
    }
  }

  suspend fun commit(handle: String, vault: String, revision: Long, epoch: Long): String {
    val storage = synchronized(session.lock) { session.requireAction(epoch, active); records() }
    val binding = storage.androidCandidateBinding(owner, handle, vault, revision)
    val detail = storage.androidSignerReview(owner, handle, vault, revision)
    val activity = owner.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
    val receipt = NativeMutationReceipt(storage)
    try {
      if (!confirmation.confirm(activity, "Connect and use Android signer?", detail, "Use this signer") {
        active() && captured(epoch) && runCatching { storage.androidCandidateBinding(owner, handle, vault, revision).sameInstallation(binding) }.getOrDefault(false)
      }) throw NativeVault.Error("AUTHORIZATION_DENIED")
      return synchronized(session.lock) {
        session.requireAction(epoch, active)
        NativeAndroidSignerInventory.requireCurrent(activity, binding)
        val result = storage.commitAndroidSigner(owner, handle, vault, revision)
        session.requireAction(epoch, active)
        expiry?.let(main::removeCallbacks); expiry = null
        result
      }
    } catch (failure: Exception) { throw receipt.failure(failure) }
    finally { runCatching { storage.cancelAndroidSigner(owner, handle) } }
  }

  suspend fun sign(request: SigningRequest): String {
    val frozen = NativeEvent.capture(request.event.unsigned, request.event.pubkey)
    if (request.source.identity != frozen.pubkey || NativeEvent.capture(request.source.unsigned, request.source.identity).canonical != frozen.canonical || !request.source.active()) throw NativeVault.Error("AUTHORIZATION_DENIED")
    val storage = synchronized(session.lock) { session.require(request.epoch, active); records() }
    val binding = synchronized(session.lock) { storage.androidSigning(owner, frozen.pubkey, request.vault, request.revision) }
    val activity = owner.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
    val row = episode(NativeHandoffController.Binding.Signing(request.kind, request.token, request.source), request.epoch, request.deadline, storage, activity, request)
    var completed = false
    try {
      val (returned, signed) = activityReply(row) { reply -> controller.requestSignatureScoped(activity, owner, binding, frozen, request.deadline, reply, hook(row)) }
      if (!returned.sameInstallation(binding)) throw NativeVault.Error("SIGNER_RESPONSE_INVALID")
      val exact = NativeSignedEvent.exact(signed, frozen)
      resume(row)
      if (!row.authorization.execute() || !request.source.resumedHandoff()) throw NativeVault.Error("AUTHORIZATION_DENIED")
      request.source.perform {
        synchronized(session.lock) {
          session.require(request.epoch, active)
          if (!storage.androidSigning(owner, frozen.pubkey, request.vault, request.revision).sameInstallation(binding)) throw NativeVault.Error("SIGNER_IDENTITY_CHANGED")
          NativeAndroidSignerInventory.requireCurrent(activity, binding)
        }
      }
      handoffs.complete(row.authorization); completed = true
      return exact
    } catch (failure: Exception) {
      val code = (failure as? NativeVault.Error)?.code
      if (row.dispatched && code in setOf(null, "AUTHORIZATION_DENIED", "SIGNER_EXPIRED", "SIGNER_APP_FAILED")) throw NativeVault.Error("SIGNER_UNCERTAIN")
      throw failure
    } finally {
      if (!completed) row.authorization.discard()
      current.compareAndSet(row, null)
    }
  }

  fun result(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) = controller.result(activity, owner, requestCode, resultCode, data)
  fun foreground(active: Boolean) = controller.foreground(active)
  fun destroyed(activity: Activity) = controller.destroyed(activity)
  fun cancelSigning(kind: String, token: String) = cancellation(kind, token).invoke()
  fun cancellation(kind: String? = null, token: String? = null): () -> Unit {
    val row = current.get()
    if (kind != null && (row?.signing?.kind != kind || row.signing.token != token)) return {}
    val stop = if (kind == null) controller.cancellation() else row?.stopRequest ?: Runnable {}
    val stopPrompt = if (kind == null) confirmation.cancellation() else ({})
    val timer = if (kind == null) expiry else null
    return {
      row?.authorization?.discard()
      if (row != null) current.compareAndSet(row, null)
      stop.run(); stopPrompt()
      if (kind == null) {
        timer?.let(main::removeCallbacks)
        if (expiry === timer) expiry = null
      }
    }
  }
  fun cancel() = cancellation().invoke()
}
