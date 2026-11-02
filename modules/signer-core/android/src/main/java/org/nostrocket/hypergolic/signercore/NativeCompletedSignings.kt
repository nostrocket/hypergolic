package org.nostrocket.hypergolic.signercore

import org.nostrocket.hypergolic.host.NativeSigningSourceFacade

/** Public source captures remain revocable after signing while publication/upload may still be running. */
internal class NativeCompletedSignings {
  private class Entry(val kind: String, val token: String, val source: NativeSigningSourceFacade.Capture)
  private val lock = Any()
  private val entries = mutableListOf<Entry>()
  // Covers the native limits of 16 approvals, 10 upload rows and one fixture release.
  private val limit = 32

  fun ensureCapacity() {
    val snapshot = synchronized(lock) { entries.toList() }
    val inactive = snapshot.filter { entry ->
      !runCatching { entry.source.active() || entry.source.handoffActive() }.getOrDefault(false)
    }.toSet()
    synchronized(lock) {
      entries.removeAll(inactive)
      if (entries.size >= limit) throw NativeVault.Error("AUTHORIZATION_DENIED")
    }
  }

  fun record(kind: String, token: String, source: NativeSigningSourceFacade.Capture) {
    synchronized(lock) {
      if (entries.size >= limit) throw NativeVault.Error("AUTHORIZATION_DENIED")
      entries.add(Entry(kind, token, source))
    }
  }

  /** Capture under the session lock; invoke afterward to preserve source -> session lock ordering. */
  fun cancellation(kind: String? = null, token: String? = null): () -> Unit {
    val captured = synchronized(lock) {
      entries.filter { kind == null || it.kind == kind && it.token == token }.also { entries.removeAll(it.toSet()) }
    }
    return {
      captured.forEach { entry ->
        entry.source.cancelCurrent { NativeSigningSourceFacade.cancel(entry.kind, entry.token) }
      }
    }
  }
}
