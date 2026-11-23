package org.nostrocket.hypergolic.host

import android.content.Context
import android.webkit.WebView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONTokener
import kotlin.coroutines.resume

/** This view has no native bridge or network, file, or content access. */
internal object ResourceSvg {
  private var active = 0
  suspend fun render(context: Context, encoded: String): String? = withContext(Dispatchers.Main.immediate) {
    if (active >= 4 || encoded.length !in 1..349528 || !encoded.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it in "+/=" }) return@withContext null
    val page = context.assets.open("resource-svg.html").bufferedReader().use { it.readText() }
    val view = WebView(context)
    active++
    try {
      view.settings.apply {
        blockNetworkLoads = true
        allowFileAccess = false
        allowContentAccess = false
        javaScriptEnabled = true
      }
      view.loadDataWithBaseURL(null, page.replace("__SVG_BASE64__", encoded), "text/html", "utf-8", null)
      withTimeoutOrNull(4000) {
        var result: String? = null
        while (result == null) {
          delay(40)
          val value = suspendCancellableCoroutine<String> { continuation ->
            view.evaluateJavascript("window.pngResult") { if (continuation.isActive) continuation.resume(it ?: "null") }
          }
          if (value.startsWith('"') && value.length <= 6291458) result = JSONTokener(value).nextValue() as? String
        }
        result.takeIf { it.isNotEmpty() }
      }
    } finally {
      active--
      view.stopLoading()
      view.destroy()
    }
  }
}
