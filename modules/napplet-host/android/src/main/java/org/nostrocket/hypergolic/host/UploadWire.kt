package org.nostrocket.hypergolic.host

import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.Base64

/** Independent native parsing for the private byte carrier and provider receipt. */
internal object UploadWire {
  fun objectValue(raw: String, limit: Int = 400 * 1024, maximumDepth: Int = 12): JSONObject {
    require(UploadJsonBounds.accepts(raw, limit, maximumDepth)); return JSONObject(raw)
  }
  fun fields(value: JSONObject, required: Set<String>, optional: Set<String> = emptySet()) {
    val keys = value.keys().asSequence().toSet()
    require(keys.containsAll(required) && (keys - required - optional).isEmpty())
  }
  fun text(value: Any?, limit: Int, empty: Boolean = false): String {
    val result = value as? String ?: error("Invalid text")
    require((empty || result.isNotEmpty()) && result.toByteArray(Charsets.UTF_8).size <= limit)
    var index = 0
    while (index < result.length) {
      val character = result[index++]
      if (Character.isHighSurrogate(character)) require(index < result.length && Character.isLowSurrogate(result[index++]))
      else require(!Character.isLowSurrogate(character))
    }
    return result
  }
  fun integer(value: Any?, maximum: Long): Long {
    require(value is Number && value !is Float && value !is Double)
    return value.toLong().also { require(it in 0..maximum) }
  }
  fun header(value: JSONObject): String {
    fields(value, emptySet(), setOf("rail", "mimeType", "filename", "caption", "noTransform", "metadata"))
    if (value.has("rail")) require(value.get("rail") == "blossom")
    if (value.has("mimeType")) require(text(value.get("mimeType"), 128).matches(Regex("[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*")))
    if (value.has("filename")) text(value.get("filename"), 256, true)
    if (value.has("caption")) text(value.get("caption"), 4096, true)
    if (value.has("noTransform")) require(value.get("noTransform") is Boolean)
    if (value.has("metadata")) metadata(value.getJSONObject("metadata"))
    // Reserialize the native interpretation once; no downstream parser receives ambiguous raw JSON.
    return value.toString().also { require(it.toByteArray(Charsets.UTF_8).size <= 32 * 1024) }
  }
  private fun metadata(value: JSONObject) {
    var nodes = 0
    fun visit(value: Any?, depth: Int) {
      require(++nodes <= 256 && depth <= 8)
      when (value) {
        null, JSONObject.NULL -> Unit
        is Boolean -> Unit
        is Number -> require(value.toDouble().isFinite())
        is String -> text(value, 16 * 1024, true)
        is JSONArray -> { require(value.length() <= 256); for (index in 0 until value.length()) visit(value.get(index), depth + 1) }
        is JSONObject -> for (key in value.keys()) { text(key, 256, true); visit(value.get(key), depth + 1) }
        else -> error("Invalid metadata")
      }
    }
    visit(value, 0); require(value.toString().toByteArray(Charsets.UTF_8).size <= 16 * 1024)
  }
  fun chunk(value: Any?): ByteArray {
    val raw = text(value, ((NativeUploadAuthority.CHUNK_BYTES + 2) / 3) * 4)
    val bytes = Base64.getDecoder().decode(raw)
    require(bytes.size in 1..NativeUploadAuthority.CHUNK_BYTES && Base64.getEncoder().encodeToString(bytes) == raw)
    return bytes
  }
  fun review(value: NativeUploadAuthority.Review): JSONObject = JSONObject().put("purpose", value.purpose)
    .put("identity", value.identity).put("destination", value.destination).put("sha256", value.sha256)
    .put("size", value.size).put("mimeType", value.mimeType).put("metadataPolicy", value.metadataPolicy)
  fun status(id: String, state: String, error: String? = null): JSONObject = JSONObject()
    .put("ok", state != "failed" && state != "cancelled").put("uploadId", id).put("status", state).put("rail", "blossom")
    .also { if (error != null) it.put("error", error) }
  val errors = setOf("invalid request", "unsupported rail", "policy denied", "no server configured", "file too large",
    "unsupported media type", "user cancelled", "server rejected", "upload failed", "quota exceeded", "outcome unknown")
  fun terminal(raw: String, id: String): JSONObject {
    require(raw.toByteArray(Charsets.UTF_8).size <= 32 * 1024)
    val value = objectValue(raw, 32 * 1024)
    fields(value, setOf("ok", "uploadId", "status", "rail"), setOf("url", "sha256", "size", "mimeType", "error", "bytesSent", "bytesTotal"))
    require(value.get("uploadId") == id && value.get("rail") == "blossom")
    val state = value.get("status")
    require(state in setOf("complete", "failed", "cancelled") && value.get("ok") == (state == "complete"))
    if (state != "complete") require(value.get("error") in errors && !value.has("url"))
    return if (state == "complete") value else status(id, state as String, value.getString("error"))
  }
  fun receipt(bytes: ByteArray, review: NativeUploadAuthority.Review, id: String): Pair<JSONObject, JSONObject> {
    require(bytes.size <= 32 * 1024)
    val decoder = StandardCharsets.UTF_8.newDecoder()
    val descriptor = objectValue(decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString(), 32 * 1024)
    require(descriptor.length() <= 32)
    metadata(descriptor)
    require(descriptor.get("sha256") == review.sha256 && integer(descriptor.get("size"), NativeUploadAuthority.MAX_BYTES.toLong()) == review.size.toLong()
      && review.acceptsDescriptorType(descriptor.get("type") as? String))
    integer(descriptor.get("uploaded"), 9_007_199_254_740_991L)
    val url = text(descriptor.get("url"), 2048)
    val parsed = PublishedHttpsTransport.validateRequest(url, PublishedHttpsRequestOwner.addressPolicy())
    require(parsed.path.matches(Regex("/" + review.sha256 + "\\.[A-Za-z0-9]{1,16}")) && parsed.query == null && parsed.ref == null)
    val result = status(id, "complete").put("url", url).put("sha256", review.sha256).put("size", review.size).put("mimeType", review.mimeType)
    return Pair(descriptor, result)
  }
  fun sameCompletion(value: JSONObject, captured: JSONObject): Boolean = runCatching {
    fields(value, setOf("ok", "uploadId", "status", "rail", "url", "sha256", "size", "mimeType"))
    value.keys().asSequence().all { value.get(it) == captured.get(it) }
  }.getOrDefault(false)
}
