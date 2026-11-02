package org.nostrocket.hypergolic.signercore

import android.os.Handler
import android.os.Looper
import com.facebook.react.common.LifecycleState
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.nostrocket.hypergolic.identityowner.NativeIdentityOwnerAccess
import org.nostrocket.hypergolic.identityowner.NativeKeyEncoding
import org.nostrocket.hypergolic.identityowner.NativeVaultIdentityActions
import org.nostrocket.hypergolic.host.NativeSigningSourceFacade
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** AppContext-bound native vault, secret entry and exact source-owned signing. */
class SignerCoreModule : Module() {
  @Volatile private var core: NativeSignerCore? = null
  private val panel = NativeReviewPanel()
  private val main = Handler(Looper.getMainLooper())
  private var expiry: Runnable? = null
  private val session = NativeVaultSession()
  private var vault: NativeVault? = null
  private var actions: NativeVaultIdentityActions? = null
  private val importer = NativeImportPanel()
  private var connections: NativeConnectionActions? = null
  private val confirmation = NativeConfirmationPanel()
  private var importExpiry: Runnable? = null
  private val handoffs by lazy { NativeHandoffController(appContext, ::active) }
  private var androidSigners: NativeAndroidSignerActions? = null
  private val completedSignings = NativeCompletedSignings()

  private class Signing(val kind: String, val token: String, val core: NativeSignerCore, val epoch: Long,
    val remote: NativeRemoteBinding? = null, val android: NativeAndroidSignerBinding? = null) {
    @Volatile var authorization: NativeHandoffController.Authorization? = null
    @Volatile var operation: NativeRemoteOperation? = null
    @Volatile var androidDispatched = false
  }
  @Volatile private var signing: Signing? = null

  private fun active(): Boolean = NativeIdentityOwnerAccess.owns(appContext) &&
    appContext.runtime.reactContext?.lifecycleState == LifecycleState.RESUMED

  private fun claimedOwner() {
    if (!NativeIdentityOwnerAccess.owns(appContext)) throw NativeVault.Error("AUTHORIZATION_DENIED")
  }

  private fun vaultOwned(): NativeVault {
    if (!session.activated || !active()) throw NativeVault.Error("AUTHORIZATION_DENIED")
    return vault ?: throw NativeVault.Error("NOT_READY")
  }

  private fun owned(): NativeSignerCore {
    if (!active()) throw NativeSignerCore.Denied()
    return core ?: throw NativeSignerCore.Denied()
  }

  private inline fun <T> vaultAction(block: () -> T): T = try {
    block()
  } catch (failure: Exception) {
    val code = if (failure is NativeVault.Error) failure.code else "AUTHORIZATION_DENIED"
    throw CodedException(code, "Native identity action could not be completed.", null)
  }

  private inline fun <T> action(block: () -> T): T = try {
    block()
  } catch (_: Exception) {
    throw CodedException("ERR_NATIVE_SIGNER_DENIED", "Native signing request could not be completed.", null)
  }

  private inline fun <T> mutationAction(records: NativeVault, block: () -> T): T {
    val receipt = NativeMutationReceipt(records)
    return try { block() } catch (failure: Exception) { throw receipt.failure(failure) }
  }

  private fun revision(value: Double): Long {
    if (!value.isFinite() || value < 1 || value > NativeVault.MAX_REVISION || value % 1.0 != 0.0) {
      throw NativeVault.Error("AUTHORIZATION_DENIED")
    }
    return value.toLong()
  }

  private fun ensureVault(): NativeVault {
    if (!session.activated || !active()) throw NativeVault.Error("AUTHORIZATION_DENIED")
    if (vault == null) {
      val context = appContext.runtime.reactContext ?: throw NativeVault.Error("NOT_READY")
      vault = NativeVault(appContext, context)
    }
    return vault!!
  }

  private fun actionsFor(expectedEpoch: Long, localRemoval: Boolean = false): NativeVaultIdentityActions {
    val next = NativeVaultIdentityActions(appContext, object : NativeVaultIdentityActions.Records {
      override fun snapshot(): String = synchronized(session.lock) {
        session.requireAction(expectedEpoch, ::active)
        vaultOwned().publicSnapshot(appContext)
      }

      override fun backup(pubkey: String, vault: String, revision: Long): CharArray = synchronized(session.lock) {
        session.requireAction(expectedEpoch, ::active)
        val scalar = vaultOwned().backupScalar(appContext, pubkey, vault, revision)
        try { NativeKeyEncoding.encode(scalar) } finally { scalar.fill(0) }
      }

      override fun erase(pubkey: String, vault: String, revision: Long) {
        synchronized(session.lock) {
          session.requireAction(expectedEpoch, ::active)
          if (localRemoval) vaultOwned().deleteLocal(appContext, pubkey, vault, revision)
          else vaultOwned().delete(appContext, pubkey, vault, revision)
        }
      }
    })
    actions = next
    return next
  }

  private fun connectionActions(): NativeConnectionActions = connections ?: NativeConnectionActions(
    appContext, session, ::vaultOwned, ::active, handoffs,
  ).also { connections = it }

  private fun androidSignerActions(): NativeAndroidSignerActions = androidSigners ?: NativeAndroidSignerActions(
    appContext, session, ::vaultOwned, ::active, handoffs,
  ).also { androidSigners = it }

  private fun clearImportTimer() {
    importExpiry?.let(main::removeCallbacks)
    importExpiry = null
  }

  // Capture cancellation targets while excluding new work; invoke source/UI callbacks after unlocking.
  private fun cancelSigning(kind: String? = null, token: String? = null) {
    val cleanup = synchronized(session.lock) {
      val current = signing?.takeIf { kind == null || it.kind == kind && it.token == token }
      if (current != null) signing = null
      val cancelHandoff = handoffs.cancellation(kind, token)
      val cancelCompleted = completedSignings.cancellation(kind, token)
      val cancelAndroid = androidSigners?.cancellation(kind, token)
      val cancelPanel = if (current != null) panel.cancellation() else null
      val effect: () -> Unit = {
        current?.operation?.close()
        cancelHandoff()
        cancelCompleted()
        cancelAndroid?.invoke()
        current?.core?.close()
        cancelPanel?.run()
        if (current != null) NativeSigningSourceFacade.cancel(current.kind, current.token)
        else if (kind != null && token != null) NativeSigningSourceFacade.cancel(kind, token)
      }
      effect
    }
    cleanup()
  }

  private fun revoke(background: Boolean) {
    val cleanup = synchronized(session.lock) {
      session.invalidate(background)
      clearImportTimer()
      if (background) vault?.close() else runCatching { vault?.cancelImports(appContext) }
      val current = signing.also { signing = null }
      val cancelHandoff = handoffs.cancellation()
      val cancelCompleted = completedSignings.cancellation()
      val cancelAndroid = androidSigners?.cancellation()
      val cancelConnection = connections?.cancellation()
      val cancelImport = importer.cancellation()
      val cancelConfirmation = confirmation.cancellation()
      val cancelPanel = panel.cancellation()
      val identityActions = actions
      val disposable = if (background) core.also { core = null } else null
      val disposableTimer = if (background) expiry.also { expiry = null } else null
      val effect: () -> Unit = {
        current?.operation?.close()
        cancelHandoff()
        cancelCompleted()
        cancelAndroid?.invoke()
        cancelConnection?.invoke()
        if (background) identityActions?.foreground(false) else identityActions?.cancel()
        cancelImport()
        cancelConfirmation()
        cancelPanel.run()
        current?.core?.close()
        if (current != null) NativeSigningSourceFacade.cancel(current.kind, current.token)
        disposable?.close()
        disposableTimer?.let(main::removeCallbacks)
      }
      effect
    }
    cleanup()
  }

  private fun cancelVaultAction() { claimedOwner(); revoke(false) }

  private suspend fun <T> exclusiveAction(block: suspend (Long) -> T): T {
    val (current, revokeCompleted) = synchronized(session.lock) {
      if (signing != null) throw NativeVault.Error("AUTHORIZATION_DENIED")
      val epoch = session.beginAction(::active)
      val cancelHandoff = handoffs.cancellation()
      val cancelCompleted = completedSignings.cancellation()
      epoch to { cancelHandoff(); cancelCompleted() }
    }
    return try { revokeCompleted(); block(current) } finally { session.finishAction(current) }
  }

  private fun retire() = revoke(true)

  private fun background() {
    if (!handoffs.background()) { retire(); return }
    val cleanup = synchronized(session.lock) {
      val identityActions = actions
      val cancelImport = importer.cancellation()
      val cancelConfirmation = confirmation.cancellation()
      val disposable = core.also { core = null }
      val timer = expiry.also { expiry = null }
      val effect: () -> Unit = {
        identityActions?.foreground(false)
        cancelImport()
        cancelConfirmation()
        disposable?.close()
        timer?.let(main::removeCallbacks)
      }
      effect
    }
    cleanup()
  }

  override fun definition() = ModuleDefinition {
    Name("HypergolicSignerCore")

    Function("activateEphemeralSigner") { action {
      if (appContext.runtime.reactContext?.isOnJSQueueThread != true || !active()) throw NativeSignerCore.Denied()
      if (core == null) core = NativeSignerCore(appContext)
      true
    } }

    AsyncFunction("generateDisposableIdentityAsync") Coroutine { -> action {
      withContext(Dispatchers.Main.immediate) {
        val current = owned()
        val result = current.generateDisposableIdentity(appContext)
        if (expiry == null) {
          val deadline = Runnable { if (core === current) retire() }
          expiry = deadline
          main.postDelayed(deadline, NativeSignerCore.LIFETIME_MS)
        }
        result
      }
    } }

    AsyncFunction("reviewAndSignDisposableEventAsync") Coroutine { unsigned: String -> action {
      withContext(Dispatchers.Main.immediate) {
        val current = owned()
        val activity = appContext.currentActivity ?: throw NativeSignerCore.Denied()
        val review = current.admit(appContext, unsigned)
        try {
          suspendCancellableCoroutine<String> { continuation ->
            continuation.invokeOnCancellation { panel.cancel() }
            panel.show(activity, current, appContext, review, { active() && core === current }) { signed ->
              if (continuation.isActive) {
                if (signed != null) continuation.resume(signed)
                else continuation.resumeWithException(NativeSignerCore.Denied())
              }
            }
          }
        } catch (failure: Exception) {
          current.cancel(appContext)
          throw failure
        }
      }
    } }

    AsyncFunction("cancelDisposableReviewAsync") Coroutine { -> action {
      withContext(Dispatchers.Main.immediate) {
        owned().cancel(appContext)
        panel.cancel()
      }
    } }

    Function("activateNativeVault") { vaultAction {
      if (appContext.runtime.reactContext?.isOnJSQueueThread != true) throw NativeVault.Error("AUTHORIZATION_DENIED")
      session.activate(::active)
      actions?.foreground(true)
      true
    } }

    AsyncFunction("isNativeVaultAvailableAsync") Coroutine { -> vaultAction {
      withContext(Dispatchers.Main.immediate) {
        active() && runCatching {
          java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
          true
        }.getOrDefault(false)
      }
    } }

    AsyncFunction("openNativeVaultAsync") Coroutine { -> vaultAction {
      val records = synchronized(session.lock) { ensureVault() }
      mutationAction(records) {
        withContext(Dispatchers.Main.immediate) {
          synchronized(session.lock) { vaultOwned().open(appContext) }
        }
      }
    } }

    AsyncFunction("prepareNativeImportAsync") Coroutine { vaultId: String, value: Double -> vaultAction {
      withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
        val expected = revision(value)
        synchronized(session.lock) { vaultOwned().assertRevision(appContext, vaultId, expected) }
        val activity = appContext.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
        var key = importer.show(activity) { active() && session.activated && session.epoch == current }
        if (key == null) null else try {
          val prepared = synchronized(session.lock) {
            session.require(current, ::active)
            vaultOwned().prepareImport(appContext, key, vaultId, expected)
          }
          key = null
          val handle = JSONObject(prepared).getString("handle")
          clearImportTimer()
          val timeout = Runnable {
            synchronized(session.lock) { runCatching { vault?.cancelImport(appContext, handle) } }
          }
          importExpiry = timeout
          main.postDelayed(timeout, 120_000)
          prepared
        } finally { key?.close() }
      } }
    } }

    Function("cancelNativeImport") { handle: String -> vaultAction {
      claimedOwner()
      synchronized(session.lock) { vault?.cancelImport(appContext, handle) }
    } }

    AsyncFunction("commitNativeImportAsync") Coroutine { handle: String, vaultId: String, value: Double -> vaultAction {
      val records = synchronized(session.lock) { vaultOwned() }
      mutationAction(records) {
      withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
        val expected = revision(value)
        val selected = synchronized(session.lock) { records.importIdentity(appContext, handle, vaultId, expected) }
        val activity = appContext.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
        val accepted = confirmation.confirm(activity, "Import this identity?",
          "Public key:\n$selected\n\nUse its local key for signing. Your active identity will change. Pending requests will be cancelled.") {
          active() && session.activated && session.epoch == current && records.importActive(appContext, handle, vaultId, expected)
        }
        if (!accepted) {
          records.cancelImport(appContext, handle)
          throw NativeVault.Error("AUTHORIZATION_DENIED")
        }
        actions?.cancel()
        synchronized(session.lock) {
          session.require(current, ::active)
          val result = vaultOwned().commitImport(appContext, handle, vaultId, expected)
          clearImportTimer()
          result
        }
      } }
      }
    } }

    AsyncFunction("selectNativeIdentityAsync") Coroutine { pubkey: String, vaultId: String, value: Double -> vaultAction {
      val records = synchronized(session.lock) { vaultOwned() }
      mutationAction(records) {
      withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
        val expected = revision(value)
        val snapshot = synchronized(session.lock) { records.assertRevision(appContext, vaultId, expected); JSONObject(records.publicSnapshot(appContext)) }
        if (snapshot.getString("selectedPubkey") != pubkey) {
          val activity = appContext.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
          val accepted = confirmation.confirm(activity, "Switch identity?", "Public key:\n$pubkey\n\nPending requests will be cancelled.") {
            active() && session.activated && session.epoch == current
          }
          if (!accepted) throw NativeVault.Error("AUTHORIZATION_DENIED")
        }
        actions?.cancel()
        synchronized(session.lock) {
          session.require(current, ::active)
          vaultOwned().select(appContext, pubkey, vaultId, expected)
        }
      } }
      }
    } }

    AsyncFunction("prepareNativeRemoteConnectionAsync") Coroutine { vaultId: String, value: Double, attemptId: String -> vaultAction {
      withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
        connectionActions().prepare(vaultId, revision(value), current, attemptId)
      } }
    } }

    AsyncFunction("prepareNativeRemoteRefreshAsync") Coroutine { pubkey: String, vaultId: String, value: Double, attemptId: String -> vaultAction {
      withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
        connectionActions().prepareRefresh(pubkey, vaultId, revision(value), current, attemptId)
      } }
    } }

    Function("cancelNativeRemoteConnection") { handle: String -> vaultAction {
      claimedOwner()
      synchronized(session.lock) { vault?.cancelRemote(appContext, handle) }
    } }
    Function("cancelNativeRemoteRefresh") { handle: String -> vaultAction {
      claimedOwner()
      synchronized(session.lock) { vault?.cancelRefresh(appContext, handle) }
    } }

    AsyncFunction("commitNativeRemoteConnectionAsync") Coroutine { handle: String, vaultId: String, value: Double -> vaultAction {
      val records = synchronized(session.lock) { vaultOwned() }
      mutationAction(records) {
        withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
          connectionActions().commit(handle, vaultId, revision(value), current, false)
        } }
      }
    } }
    AsyncFunction("commitNativeRemoteRefreshAsync") Coroutine { handle: String, vaultId: String, value: Double -> vaultAction {
      val records = synchronized(session.lock) { vaultOwned() }
      mutationAction(records) {
        withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
          connectionActions().commit(handle, vaultId, revision(value), current, true)
        } }
      }
    } }

    Function("nativeSigningHandoffState") { kind: String, token: String -> vaultAction {
      claimedOwner()
      handoffs.signingState(kind, token)
    } }
    Function("nativeRemotePreparationHandoffState") { vaultId: String, value: Double, attemptId: String -> vaultAction {
      claimedOwner()
      handoffs.preparationState(vaultId, revision(value), attemptId)
    } }

    AsyncFunction("prepareNativeAndroidSignerAsync") Coroutine { vaultId: String, value: Double, attemptId: String -> vaultAction {
      withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
        androidSignerActions().prepare(vaultId, revision(value), current, attemptId)
      } }
    } }
    Function("cancelNativeAndroidSigner") { handle: String -> vaultAction {
      claimedOwner()
      synchronized(session.lock) { vault?.cancelAndroidSigner(appContext, handle) }
    } }
    AsyncFunction("commitNativeAndroidSignerAsync") Coroutine { handle: String, vaultId: String, value: Double -> vaultAction {
      val records = synchronized(session.lock) { vaultOwned() }
      mutationAction(records) {
        withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
          androidSignerActions().commit(handle, vaultId, revision(value), current)
        } }
      }
    } }

    AsyncFunction("getNativeSigningMethodsAsync") Coroutine { pubkey: String, vaultId: String, value: Double -> vaultAction {
      withContext(Dispatchers.Main.immediate) {
        synchronized(session.lock) { vaultOwned().methods(appContext, pubkey, vaultId, revision(value)) }
      }
    } }

    AsyncFunction("selectNativeSigningMethodAsync") Coroutine { pubkey: String, method: String, vaultId: String, value: Double -> vaultAction {
      val records = synchronized(session.lock) { vaultOwned() }
      mutationAction(records) {
        withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
          val expected = revision(value)
          val metadata = synchronized(session.lock) { JSONObject(records.methods(appContext, pubkey, vaultId, expected)) }
          if (metadata.optString("selectedMethod") != method) {
            if (method != "local" && method != "nip46" && method != "nip55") throw NativeVault.Error("SIGNER_UNSUPPORTED")
            val activity = appContext.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
            val methodName = when (method) {
              "local" -> "the local protected key"
              "nip46" -> "the saved NIP-46 signer"
              else -> "the saved Android signer app"
            }
            val detail = "Identity:\n$pubkey\n\nUse $methodName.\n\nPending requests will be cancelled."
            if (!confirmation.confirm(activity, "Change signing method?", detail, "Use signing method") {
              active() && session.activated && session.epoch == current
            }) throw NativeVault.Error("AUTHORIZATION_DENIED")
          }
          synchronized(session.lock) {
            session.require(current, ::active)
            records.selectMethod(appContext, pubkey, method, vaultId, expected)
          }
        } }
      }
    } }

    AsyncFunction("disconnectNativeSigningMethodAsync") Coroutine { pubkey: String, method: String, vaultId: String, value: Double -> vaultAction {
      val records = synchronized(session.lock) { vaultOwned() }
      mutationAction(records) {
        withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
          val expected = revision(value)
          synchronized(session.lock) { records.methods(appContext, pubkey, vaultId, expected) }
          if (method != "nip46" && method != "nip55") throw NativeVault.Error("SIGNER_UNSUPPORTED")
          val activity = appContext.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
          if (!confirmation.confirm(activity, "Disconnect saved signer?",
            "Identity:\n$pubkey\n\nRemove this saved signing capability. Account data and any local key remain. No signing method will be chosen automatically.", "Disconnect signer") {
            active() && session.activated && session.epoch == current
          }) throw NativeVault.Error("AUTHORIZATION_DENIED")
          synchronized(session.lock) {
            session.require(current, ::active)
            records.disconnect(appContext, pubkey, method, vaultId, expected)
          }
        } }
      }
    } }

    AsyncFunction("deleteNativeLocalKeyAsync") Coroutine { pubkey: String, vaultId: String, value: Double -> vaultAction {
      val records = synchronized(session.lock) { vaultOwned() }
      mutationAction(records) {
        withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
          val expected = revision(value)
          synchronized(session.lock) { records.methods(appContext, pubkey, vaultId, expected) }
          val activity = appContext.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
          if (!confirmation.confirm(activity, "Remove local private key?",
            "Identity:\n$pubkey\n\nYou need a backup to restore this private key. Account data and any remote signer remain. No signing method will be chosen automatically.", "Continue to authentication") {
            active() && session.activated && session.epoch == current
          }) throw NativeVault.Error("AUTHORIZATION_DENIED")
          actionsFor(current, true).delete(activity, pubkey, vaultId, expected, true)
          synchronized(session.lock) {
            session.require(current, ::active)
            records.publicSnapshot(appContext)
          }
        } }
      }
    } }

    AsyncFunction("isNativeVaultAuthenticationAvailableAsync") Coroutine { -> vaultAction {
      withContext(Dispatchers.Main.immediate) {
        vaultOwned()
        appContext.currentActivity?.let { (actions ?: actionsFor(session.epoch)).available(it) } ?: false
      }
    } }

    AsyncFunction("showNativeBackupAsync") Coroutine { pubkey: String, vaultId: String, value: Double -> vaultAction {
      withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
        vaultOwned()
        val activity = appContext.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
        actionsFor(current).backup(activity, pubkey, vaultId, revision(value))
      } }
    } }

    AsyncFunction("deleteNativeIdentityAsync") Coroutine { pubkey: String, vaultId: String, value: Double -> vaultAction {
      val records = synchronized(session.lock) { vaultOwned() }
      mutationAction(records) {
      withContext(Dispatchers.Main.immediate) { exclusiveAction { current ->
        vaultOwned()
        val activity = appContext.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
        actionsFor(current).delete(activity, pubkey, vaultId, revision(value))
        synchronized(session.lock) {
          session.require(current, ::active)
          vaultOwned().publicSnapshot(appContext)
        }
      } }
      }
    } }

    Function("cancelNativeVaultAction") { vaultAction { cancelVaultAction() } }
    Function("cancelNativeSigning") { kind: String, token: String -> vaultAction {
      claimedOwner()
      cancelSigning(kind, token)
    } }

    AsyncFunction("reviewAndSignNativeEventAsync") Coroutine { kind: String, token: String, unsigned: String, vaultId: String, value: Double -> vaultAction {
      withContext(Dispatchers.Main.immediate) {
        if (signing != null || session.actionBusy) throw NativeVault.Error("AUTHORIZATION_DENIED")
        completedSignings.ensureCapacity()
        val expected = revision(value)
        val records = vaultOwned()
        val source = NativeSigningSourceFacade.capture(kind, token, unsigned)
        val event = NativeEvent.capture(unsigned, source.identity)
        val captured = NativeEvent.capture(source.unsigned, source.identity)
        if (event.canonical != captured.canonical || kind == "approval" && (event.kind == 22242 || event.kind == 24242)) {
          throw NativeVault.Error("AUTHORIZATION_DENIED")
        }
        val pending = synchronized(session.lock) {
          session.require(session.epoch, ::active)
          if (signing != null || session.actionBusy) throw NativeVault.Error("AUTHORIZATION_DENIED")
          val method = JSONObject(records.methods(appContext, source.identity, vaultId, expected)).optString("selectedMethod")
          val pending = when (method) {
            "local" -> Signing(kind, token, NativeSignerCore.ownedKey(appContext,
              records.signingKey(appContext, source.identity, vaultId, expected)), session.epoch)
            "nip46" -> Signing(kind, token, NativeSignerCore.reviewOnly(appContext, source.identity), session.epoch,
              records.remoteSigning(appContext, source.identity, vaultId, expected))
            "nip55" -> Signing(kind, token, NativeSignerCore.reviewOnly(appContext, source.identity), session.epoch,
              android = records.androidSigning(appContext, source.identity, vaultId, expected))
            else -> throw NativeVault.Error("SIGNER_UNAVAILABLE")
          }
          pending.also { signing = it }
        }
        val current = pending.core
        var succeeded = false
        try {
          val review = current.admit(appContext, event.unsigned)
          val activity = appContext.currentActivity ?: throw NativeVault.Error("AUTHORIZATION_DENIED")
          val deadline = android.os.SystemClock.elapsedRealtime() + 120_000L
          val failure = java.util.concurrent.atomic.AtomicReference<Exception?>(null)
          val result = suspendCancellableCoroutine<String> { continuation ->
            continuation.invokeOnCancellation { main.post { if (signing === pending) cancelSigning(kind, token) } }
            val valid = {
              session.activated && signing === pending && session.epoch == pending.epoch &&
                ((active() && source.active()) || handoffs.signingState(kind, token) != null) &&
                (pending.remote == null && pending.android == null || android.os.SystemClock.elapsedRealtime() < deadline)
            }
            val completed: (String?) -> Unit = { result ->
              if (continuation.isActive) {
                if (result != null) {
                  try {
                    source.perform {
                      synchronized(session.lock) {
                        session.require(pending.epoch, ::active)
                        if (signing !== pending) throw NativeVault.Error("AUTHORIZATION_DENIED")
                        records.assertRevision(appContext, vaultId, expected)
                        completedSignings.record(kind, token, source)
                      }
                    }
                    pending.authorization?.let { handoffs.complete(it) }
                    continuation.resume(result)
                  } catch (error: Exception) {
                    val uncertain = (pending.remote != null || pending.android != null) &&
                      ((error is NativeVault.Error && (error.code == "AUTHORIZATION_DENIED" || error.code == "SIGNER_EXPIRED")) ||
                        (error is IllegalArgumentException && !runCatching { source.active() }.getOrDefault(false)))
                    continuation.resumeWithException(if (uncertain) NativeVault.Error("SIGNER_UNCERTAIN") else error)
                  }
                } else continuation.resumeWithException(failure.get() ?: NativeVault.Error(
                  if (pending.operation?.uncertain() == true || pending.androidDispatched) "SIGNER_UNCERTAIN" else "AUTHORIZATION_DENIED"))
              }
            }
            val remote = pending.remote
            val android = pending.android
            if (remote == null && android == null) {
              panel.show(activity, current, appContext, review, source.requester, "Local protected identity", source.destinations,
                valid, { source.sign {
                  synchronized(session.lock) {
                    session.require(pending.epoch, ::active)
                    if (signing !== pending) throw NativeVault.Error("AUTHORIZATION_DENIED")
                    records.assertRevision(appContext, vaultId, expected)
                    current.approveOnce(appContext, review)
                  }
                } }, completed)
            } else {
              val method = if (remote != null) {
                "Saved NIP-46 signer\nPeer: ${remote.peer}\nSigner relays:\n${remote.relays.joinToString("\n")}\n\nPublication destinations are listed separately below."
              } else {
                "Saved Android signer app\nPackage: ${android!!.packageName}\nSigning certificates (SHA-256):\n${android.certificateSha256s.joinToString("\n")}"
              }
              panel.showAsync(activity, current, appContext, review, source.requester, method,
                source.destinations, valid, { deliver ->
                  source.sign {
                    synchronized(session.lock) {
                      session.require(pending.epoch, ::active)
                      if (signing !== pending) throw NativeVault.Error("AUTHORIZATION_DENIED")
                      records.assertRevision(appContext, vaultId, expected)
                      current.consumeOnce(appContext, review)
                      ""
                    }
                  }
                  if (android != null) {
                    CoroutineScope(continuation.context).launch {
                      try {
                        val result = androidSignerActions().sign(NativeAndroidSignerActions.SigningRequest(
                          kind, token, event, vaultId, expected, pending.epoch, deadline, source,
                          onDispatch = { pending.androidDispatched = true },
                        ))
                        deliver.accept(result)
                      } catch (error: Exception) { failure.set(error); deliver.accept(null) }
                    }
                  } else {
                    val captured = {
                      runCatching {
                        synchronized(session.lock) {
                          session.require(pending.epoch) { NativeIdentityOwnerAccess.owns(appContext) }
                          if (signing !== pending || !current.canFinish(appContext, review)) throw NativeVault.Error("AUTHORIZATION_DENIED")
                          records.assertRevision(appContext, vaultId, expected)
                        }
                        true
                      }.getOrDefault(false)
                    }
                    val authorization = handoffs.authorization(
                      NativeHandoffController.Binding.Signing(kind, token, source), pending.epoch, deadline,
                      NativeHandoffController.Checks({ active() && source.active() && captured() }, captured,
                        { if (signing === pending) cancelSigning(kind, token) }),
                    )
                    pending.authorization = authorization
                    val operation = NativeRemoteOperation(deadline, object : NativeRemoteOperation.Guard {
                      override fun check() {
                        if (!authorization.receive()) throw NativeVault.Error("AUTHORIZATION_DENIED")
                      }
                      override fun execute() {
                        if (!authorization.execute()) throw NativeVault.Error("AUTHORIZATION_DENIED")
                        source.perform {
                          synchronized(session.lock) {
                            session.require(pending.epoch, ::active)
                            if (signing !== pending || !current.canFinish(appContext, review)) throw NativeVault.Error("AUTHORIZATION_DENIED")
                            records.assertRevision(appContext, vaultId, expected)
                          }
                        }
                      }
                      override fun beforeSigningSend() = execute()
                    })
                    pending.operation = operation
                    CoroutineScope(continuation.context).launch(Dispatchers.IO) {
                      try {
                        val result = NativeNip46Client(remote!!, operation).authorization(authorization).use { it.sign(event) }
                        operation.execute()
                        deliver.accept(result)
                      } catch (error: Exception) {
                        failure.set(error)
                        deliver.accept(null)
                      } finally { operation.close() }
                    }
                  }
                }, completed)
            }
          }
          succeeded = true
          result
        } finally {
          if (!succeeded) {
            handoffs.cancelSigning(kind, token)
            androidSigners?.cancelSigning(kind, token)
            NativeSigningSourceFacade.cancel(kind, token)
          }
          synchronized(session.lock) { if (signing === pending) signing = null }
          pending.operation?.close()
          current.close()
          pending.remote?.close()
        }
      }
    } }

    OnActivityEntersForeground {
      androidSigners?.foreground(true)
      handoffs.foreground()
    }
    OnActivityEntersBackground { background(); androidSigners?.foreground(false) }
    OnUserLeavesActivity { background() }
    OnActivityResult { activity, result ->
      androidSigners?.result(activity, result.requestCode, result.resultCode, result.data)
    }
    OnActivityDestroys { retire() }
    OnDestroy { retire() }
  }
}
