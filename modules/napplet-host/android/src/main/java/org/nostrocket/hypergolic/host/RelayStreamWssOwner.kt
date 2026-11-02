package org.nostrocket.hypergolic.host

import java.io.IOException
import java.net.Socket
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Native-only WSS owner. One raw frame awaits RN acknowledgement per connection. */
internal object RelayStreamWssOwner {
  private val pool = ThreadPoolExecutor(0, 16, 30, TimeUnit.SECONDS, SynchronousQueue<Runnable>(), { task ->
    Thread(task, "napplet-relay-stream").apply { isDaemon = true }
  })
  private val rows = mutableMapOf<String, Row>()
  private val consumed = mutableSetOf<String>()
  @Volatile private var foreground = false
  private class Row(val id: String, val token: String, val emit: (Map<String, Any>) -> Unit) : PublishedRelayWssQuery.StreamControl {
    @Volatile var cancelled = false
    @Volatile var socket: Socket? = null
    var sequence = 0L
    @Volatile var waiting = 0L
    private val monitor = Object()
    override fun isCancelled() = cancelled || !foreground || !RelaySubscriptionTransport.registry.isActive(token)
    override fun attach(value: Socket) { socket = value; if (isCancelled()) { value.close(); throw IOException("Relay stream revoked") } }
    override fun text(text: String) {
      val deadline = System.nanoTime() + 25_000_000_000L
      while (!isCancelled() && (waiting != 0L || !RelaySubscriptionTransport.hasCapacity(token))) {
        if (System.nanoTime() >= deadline) throw IOException("Relay stream acknowledgement expired")
        synchronized(monitor) { monitor.wait(20) }
      }
      if (isCancelled() || sequence >= 9_007_199_254_740_991L) throw IOException("Relay stream revoked")
      waiting = ++sequence
      emit(mapOf("operationId" to id, "sequence" to sequence, "frame" to text))
    }
    fun acknowledge(value: Long) { synchronized(monitor) { if (value == waiting) { waiting = 0; monitor.notifyAll() } else cancel() } }
    fun cancel() { cancelled = true; try { socket?.close() } catch (_: IOException) { }; synchronized(monitor) { monitor.notifyAll() } }
  }
  @Synchronized fun start(id: String, token: String, url: String, request: String, subId: String,
    emit: (Map<String, Any>) -> Unit): Boolean {
    if (!foreground || !PublishedRelayWssRequestOwner.isCanonicalUuid(id) || consumed.size >= 65_536 ||
      consumed.contains(id) || rows.size >= 16 || rows.values.count { it.token == token } >= RelaySubscriptionTransport.registry.connectionLimit(token) || !RelaySubscriptionTransport.registry.isActive(token)) return false
    try { PublishedRelayResponseClassifier.validateRequest(request, subId); PublishedRelayWssQuery.parseUrl(url) } catch (_: Exception) { return false }
    consumed.add(id)
    val row = Row(id, token, emit); rows[id] = row
    try { pool.execute {
      try { PublishedRelayWssQuery.stream(url, request, subId, PublishedHttpsRequestOwner.addressPolicy(), row) }
      catch (_: Exception) {
        if (!row.isCancelled()) emit(mapOf("operationId" to id, "failed" to true))
      } finally { synchronized(this) { if (rows[id] === row) rows.remove(id) }; row.cancel() }
    } } catch (_: Exception) { rows.remove(id); row.cancel(); return false }
    return true
  }
  @Synchronized fun acknowledge(id: String, sequence: Long) { rows[id]?.acknowledge(sequence) }
  @Synchronized fun cancel(id: String) {
    val row = rows.remove(id); row?.cancel()
    if (row == null && PublishedRelayWssRequestOwner.isCanonicalUuid(id) && consumed.size < 65_536) consumed.add(id)
  }
  @Synchronized fun cancelToken(token: String) { rows.values.filter { it.token == token }.map { it.id }.forEach(::cancel) }
  @Synchronized fun setForeground(value: Boolean) { foreground = value; if (!value) revokeAll() }
  @Synchronized fun revokeAll() { rows.values.toList().forEach { it.cancel() }; rows.clear() }
}
