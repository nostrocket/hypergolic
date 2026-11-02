package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONTokener
import java.io.IOException

/** Retains the first exact ACK even if the relay subsequently closes or sends invalid data. */
internal class OutboxAcknowledgement(private val eventId: String) {
  data class Ack(val accepted: Boolean, val reason: String)
  @Volatile var result: Ack? = null
    private set
  @Synchronized fun classify(text: String): PublishedRelayWssQuery.TextKind {
    if (!OutboxResponseJson.accepts(text)) throw IOException("Invalid relay response")
    val value = runCatching {
      val parser = JSONTokener(text)
      val parsed = JSONArray(parser)
      if (parser.nextClean() != '\u0000') throw IOException("Trailing relay data")
      parsed
    }.getOrElse { throw IOException("Invalid relay JSON") }
    if (value.opt(0) != "OK" || value.opt(1) != eventId) return PublishedRelayWssQuery.TextKind.OTHER
    if (value.length() != 4 || value.get(2) !is Boolean || value.get(3) !is String || value.getString(3).toByteArray(Charsets.UTF_8).size > 4096) throw IOException("Invalid relay acknowledgement")
    if (result == null) result = Ack(value.get(2) == true, value.getString(3))
    return PublishedRelayWssQuery.TextKind.EOSE
  }
}
