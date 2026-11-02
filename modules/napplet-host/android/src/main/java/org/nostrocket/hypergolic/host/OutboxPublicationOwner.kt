package org.nostrocket.hypergolic.host

import android.os.SystemClock
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Semaphore
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.net.Socket

/** App-only native sender. No guest URL, event or read-query token grants publication. */
internal object OutboxPublicationOwner {
  private val slots = Semaphore(4)
  private val deadlineCloser = ScheduledThreadPoolExecutor(1) { work -> Thread(work, "outbox-write-deadline").apply { isDaemon = true } }.apply { removeOnCancelPolicy = true }
  fun publish(token: String, group: String, wire: String, relay: String, job: () -> Boolean): String {
    require(UploadJsonBounds.accepts(wire, NativeApprovalAuthority.MAX_BYTES))
    var send: NativeOutboxPlan.Send? = null
    ApprovalTransport.leases.performApproved(token) {
      val plan = ApprovalTransport.leases.prepared(token) as? NativeOutboxPlan ?: throw IOException("Missing reviewed plan")
      send = plan.reserve(group, wire, relay, SystemClock.elapsedRealtime())
    }
    val operation = send!!
    var status = "cancelled-before-send"
    var reason = "publication capacity unavailable"
    val acknowledgement = OutboxAcknowledgement(operation.eventId)
    if (slots.tryAcquire()) {
      var closeDeadline: ScheduledFuture<*>? = null
      val hardStop = minOf(operation.deadline, SystemClock.elapsedRealtime() + PublishedRelayWssQuery.TOTAL_TIMEOUT_MS)
      try {
        val control = object : PublishedRelayWssQuery.PublicationControl {
          override fun isCancelled(): Boolean = !job() || SystemClock.elapsedRealtime() >= operation.deadline || !ApprovalTransport.leases.isApproved(token)
          override fun attach(socket: Socket) {
            closeDeadline = deadlineCloser.schedule({ runCatching { socket.close() } }, maxOf(0, hardStop - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS)
          }
          override fun send(action: PublishedRelayWssQuery.SendAction) {
            ApprovalTransport.leases.performApproved(token) {
              if (isCancelled) throw IOException("Publication revoked or timed out")
              operation.attempted = true
              action.run()
            }
          }
        }
        PublishedRelayWssQuery.publish(NativeOutboxPlan.transportUrl(relay), operation.frame, control, acknowledgement::classify)
        status = "unknown"; reason = "relay acknowledgement unavailable"
      } catch (_: Exception) {
        status = if (operation.attempted) "unknown" else "cancelled-before-send"
        reason = if (operation.attempted) "relay acknowledgement unavailable" else "publication stopped before send"
      } finally { closeDeadline?.cancel(false); slots.release() }
    }
    acknowledgement.result?.let { status = if (it.accepted) "accepted" else "rejected"; reason = it.reason }
    return JSONObject().put("relay", relay).put("eventId", operation.eventId).put("status", status).put("reason", reason).toString()
  }
}
