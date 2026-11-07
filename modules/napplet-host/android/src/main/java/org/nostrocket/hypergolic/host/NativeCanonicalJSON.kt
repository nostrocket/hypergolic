package org.nostrocket.hypergolic.host

import java.security.MessageDigest

/** Shared exact JSON string encoding; no parser, key or effect authority. */
internal object NativeCanonicalJSON {
fun quote(value: String): String = buildString {
    append('"')
    var index = 0
    while (index < value.length) {
      val character = value[index++]
      when (character) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\b' -> append("\\b")
        '\u000c' -> append("\\f")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else -> if (character.code < 32) append("\\u%04x".format(character.code)) else {
          if (Character.isHighSurrogate(character)) { require(index < value.length && Character.isLowSurrogate(value[index])); append(character); append(value[index++]) }
          else { require(!Character.isLowSurrogate(character)); append(character) }
        }
      }
    }
    append('"')
  }
  fun hashStrings(values: List<String>): String {
    val canonical = values.joinToString(",", "[", "]", transform = ::quote)
    return MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
  }
}
