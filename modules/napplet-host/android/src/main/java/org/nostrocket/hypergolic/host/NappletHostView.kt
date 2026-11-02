package org.nostrocket.hypergolic.host

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Message
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.*
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebMessageCompat
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.Collections
import java.util.WeakHashMap

/** Owns one trusted document. No arbitrary URL, HTML or privileged operation prop. */
@SuppressLint("SetJavaScriptEnabled")
class NappletHostView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onHostEvent by EventDispatcher()
  override val shouldUseAndroidLayout = true
  private var sessionId: String? = null
  @Volatile private var configuration: CapabilityConfiguration? = null
  private var published: PublishedClaims? = null
  private var publishedSource: String? = null
  private var publishedReader: PublishedArtifactReadOwner? = null
  private val generation = UUID.randomUUID().toString()
  @Volatile private var live = false
  @Volatile private var loaded = false
  @Volatile private var ready = false
  @Volatile private var disposed = false
  @Volatile private var active = false
  private var expectedUrl: String? = null
  private var closeCheckId: String? = null
  private var closeCheckDeadline = 0L
  private val pendingNativeReplies = mutableMapOf<String, Long>()
  private var closeUnsafeUntil = 0L
  private var pickerFaultProof: String? = null
  private val webView = WebView(context)
  private val assetLoader = WebViewAssetLoader.Builder()
    .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()

  init {
    synchronized(publishedViews) { publishedViews.add(this) }
    webView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    webView.setBackgroundColor(0xff120e0a.toInt())
    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = false
      allowFileAccess = false
      allowContentAccess = false
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      mediaPlaybackRequiresUserGesture = true
      setGeolocationEnabled(false)
      cacheMode = WebSettings.LOAD_NO_CACHE
    }
    CookieManager.getInstance().setAcceptCookie(false)
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
    webView.setDownloadListener { _, _, _, _, _ -> }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
      override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
        callback?.invoke(origin, false, false)
      }
      override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean {
        if (callback == null) return true
        if (view !== webView || params == null || params.mode != FileChooserParams.MODE_OPEN || params.isCaptureEnabled || !maySelectFile()) {
          callback.onReceiveValue(null); return true
        }
        SelectedFilePicker.choose(appContext.currentActivity, generation, { maySelectFile() }, callback)
        schedulePickerFaultProof()
        return true
      }
      override fun onCreateWindow(view: WebView?, dialog: Boolean, gesture: Boolean, result: Message?) = false
      override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
        result?.cancel(); return true
      }
      override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
        result?.cancel(); return true
      }
      override fun onJsPrompt(view: WebView?, url: String?, message: String?, value: String?, result: JsPromptResult?): Boolean {
        result?.cancel(); return true
      }
    }
    webView.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
        val uri = request.url
        val allowedOrigin = uri.scheme == "https" && uri.host == HOST && uri.port == -1 && uri.userInfo == null
        val allowedPath = (request.isForMainFrame && uri.toString() == expectedUrl) ||
          (!request.isForMainFrame && uri.path == "/assets/runtime/host.js" && uri.query == null && uri.fragment == null)
        if (!live || !allowedOrigin || !allowedPath || request.method != "GET") return blocked()
        return assetLoader.shouldInterceptRequest(uri)?.also {
          it.responseHeaders = mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")
        } ?: blocked()
      }
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (request.isForMainFrame || (configuration != null && ready)) fail("navigation-blocked")
        return true
      }
      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        if (url != expectedUrl || loaded) { fail("navigation-blocked"); view.stopLoading() }
      }
      override fun onPageFinished(view: WebView, url: String?) {
        if (live && url == expectedUrl) { loaded = true; updateMediaPlayback() }
      }
      override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) { handler.cancel() }
      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) fail("host-load-failed")
      }
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        fail("renderer-stopped"); destroySession(); return true
      }
    }
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.addWebMessageListener(webView, "HypergolicHost", setOf(ORIGIN)) { view, message, origin, mainFrame, reply ->
        if (!live || view !== webView || !mainFrame || origin.toString() != ORIGIN || view.url != expectedUrl) return@addWebMessageListener
        if (message.type != WebMessageCompat.TYPE_STRING) {
          if (published != null) fail("artifact-message-invalid")
          return@addWebMessageListener
        }
        val text = message.data ?: run {
          if (published != null) fail("artifact-message-invalid")
          return@addWebMessageListener
        }
        if (text.toByteArray(Charsets.UTF_8).size > CapabilityLeaseRegistry.MAX_BYTES) {
          if (published != null) fail("artifact-message-invalid")
          return@addWebMessageListener
        }
        try {
          val data = JSONObject(text)
          if (data.optString("type") == "artifact.read" && published != null) {
            if (data.optString("sessionId") != generation) { fail("artifact-read-invalid"); return@addWebMessageListener }
            val chunk = receivePublishedRead(data) ?: run {
              fail("artifact-read-invalid"); return@addWebMessageListener
            }
            val claims = published ?: return@addWebMessageListener
            val result = JSONObject().put("type", "artifact.chunk").put("sessionId", generation)
              .put("sequence", chunk.sequence).put("base64", chunk.base64)
              .put("byteLength", chunk.byteLength).put("totalBytes", chunk.totalBytes)
              .put("publisher", claims.publisher).put("appId", claims.appId)
              .put("eventId", claims.eventId).put("version", claims.version)
              .put("htmlHash", claims.htmlHash).put("domains", JSONArray(configuration?.grantedDomains ?: listOf("theme")))
              .put("done", chunk.done)
            reply.postMessage(result.toString())
            return@addWebMessageListener
          }
          if (data.optString("sessionId") != generation) return@addWebMessageListener
          if (data.optString("type") == "routing-ack") {
            if (data.keys().asSequence().toSet() != setOf("type", "sessionId", "sequence", "delivery")) return@addWebMessageListener
            val seq = data.opt("sequence"); val delivery = data.opt("delivery")
            if ((seq !is Int && seq !is Long) || (delivery !is Int && delivery !is Long)) return@addWebMessageListener
            if ((delivery as Number).toLong() !in 1..9_007_199_254_740_991L || !CapabilityTransport.leases.consumeSequence(generation, (seq as Number).toLong())) return@addWebMessageListener
            RoutingTransport.acknowledge(generation, delivery.toLong())
            return@addWebMessageListener
          }
          if (data.optString("type") == "relay-stream-ack") {
            receiveStreamAck(data)
            return@addWebMessageListener
          }
          if (data.optString("type") == "relay-stream") {
            receiveSubscription(data) { envelope ->
              if (live && !disposed && view === webView && view.url == expectedUrl) reply.postMessage(envelope)
            }
            return@addWebMessageListener
          }
          if (data.optString("type") == "capability") {
            receiveCapability(data, { envelope ->
              if (live && !disposed && view === webView && view.url == expectedUrl) reply.postMessage(envelope)
            }) { response ->
              if (live && !disposed && view === webView && view.url == expectedUrl) {
                val result = JSONObject().put("type", "capability.result").put("sessionId", generation)
                  .put("sequence", data.getLong("sequence")).put("response", response ?: JSONObject.NULL)
                reply.postMessage(result.toString())
              }
            }
            return@addWebMessageListener
          }
          if (text.toByteArray(Charsets.UTF_8).size > 2048) return@addWebMessageListener
          when (data.optString("type")) {
            "close-check.result" -> receiveCloseCheck(data)
            "ready" -> if (data.length() == 2 && !ready) { ready = true; RoutingTransport.ready(generation); emit("ready") }
            "error" -> if (data.length() == 3 && data.optString("code").matches(Regex("[a-z-]{1,80}"))) fail(data.getString("code"))
          }
        } catch (_: Exception) {
          if (published != null) fail("artifact-message-invalid")
        }
      }
    }
    addView(webView)
  }

  fun setCloseCheck(raw: String) {
    closeCheckId = null
    if (!live || !ready || !loaded || disposed || !mediaForeground || raw.toByteArray(Charsets.UTF_8).size > 256 || webView.url != expectedUrl) return
    val value = runCatching { JSONObject(raw) }.getOrNull() ?: return
    if (value.keys().asSequence().toSet() != setOf("id", "generation") || value.optString("generation") != generation) return
    val id = value.opt("id") as? String ?: return
    if (!id.matches(Regex("[A-Za-z0-9_-]{1,80}"))) return
    closeCheckId = id
    closeCheckDeadline = android.os.SystemClock.elapsedRealtime() + 500
    webView.evaluateJavascript("if(location.href===${JSONObject.quote(expectedUrl)}){window.postMessage({type:'hypergolic.close-check.request',id:${JSONObject.quote(id)}},'*')}", null)
  }

  private fun receiveCloseCheck(data: JSONObject) {
    val now = android.os.SystemClock.elapsedRealtime()
    if (!ready || !mediaForeground || data.keys().asSequence().toSet() != setOf("type", "sessionId", "id", "state") ||
        data.opt("id") != closeCheckId || closeCheckId == null || now >= closeCheckDeadline) return
    val state = data.opt("state") as? String ?: return
    if (state !in listOf("clean", "dirty", "unknown")) return
    val id = closeCheckId!!
    closeCheckId = null
    pendingNativeReplies.entries.removeAll { it.value <= now }
    val guarded = if (state == "clean" && (pendingNativeReplies.isNotEmpty() || closeUnsafeUntil > now)) "dirty" else state
    onHostEvent(mapOf("type" to "close-check", "sessionId" to (sessionId ?: ""), "generation" to generation, "id" to id, "state" to guarded))
  }

  fun setActive(active: Boolean) {
    if (disposed || this.active == active) return
    this.active = active
    if (!active) SelectedFilePicker.revoke(generation)
    updateMediaPlayback()
    ApprovalTransport.focus(generation, active)
    UploadTransport.focus(generation, active)
    RoutingTransport.focus(generation, active)
    LinkTransport.focus(generation, active)
    webView.importantForAccessibility = if (active) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
      else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    if (active || !webView.hasFocus()) return
    val token = webView.windowToken
    webView.clearFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
      ?.hideSoftInputFromWindow(token, 0)
  }

  private fun updateMediaPlayback() {
    if (disposed) return
    val playingAllowed = active && mediaForeground
    if (loaded) webView.evaluateJavascript("window.__hypergolicMediaActive?.($playingAllowed)", null)
    // Loaded foreground views also render the live overview. Focus gates media and
    // privileged actions separately; pausing an unfocused renderer blanks its card.
    if (mediaForeground) webView.onResume() else webView.onPause()
  }

  /** Compile-gated controlled fault; no guest operation or production behavior. */
  fun armPickerFaultProof(action: String) {
    if (!BuildConfig.UPLOAD_NETWORK_PROOF) return
    pickerFaultProof = action.takeIf { it in setOf("close", "replace", "identity", "renderer") }
  }
  private fun schedulePickerFaultProof() {
    if (!BuildConfig.UPLOAD_NETWORK_PROOF) return
    val action = pickerFaultProof ?: return
    pickerFaultProof = null
    scheduleHostFaultProof(action, 12_000)
  }
  /** Actual native revocation/renderer faults for an already dispatched isolated upload. */
  fun armUploadFaultProof(action: String) {
    if (!BuildConfig.UPLOAD_NETWORK_PROOF || action !in setOf("close", "replace", "identity", "renderer")) return
    scheduleHostFaultProof(action, 2_000)
  }
  private fun scheduleHostFaultProof(action: String, delay: Long) {
    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
      if (disposed || !live) return@postDelayed
      when (action) {
        "close" -> fail("proof-close")
        "renderer" -> if (android.os.Build.VERSION.SDK_INT >= 29 && webView.webViewRenderProcess?.terminate() != true) fail("proof-renderer-unavailable")
        else -> {
          val value = JSONObject(configuration?.snapshot ?: return@postDelayed).apply {remove("generation")}
          if (action == "replace") value.put("epoch", value.getLong("epoch") + 1)
          else value.put("user", "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5")
          startConfiguredSession(value.toString())
        }
      }
    }, delay)
  }

  fun startConfiguredSession(raw: String) {
    if (disposed) return
    if (sessionId != null) {
      // A native generation is immutable, including repeated React prop updates.
      try {
        if (CapabilityConfiguration(raw, generation).snapshot == configuration?.snapshot) return
      } catch (_: Exception) { }
      fail("session-reuse-blocked"); return
    }
    try { configuration = CapabilityConfiguration(raw, generation) }
    catch (_: Exception) { fail("invalid-session"); return }
    startSession(configuration!!.sessionId)
  }

  private data class PublishedClaims(
    val sessionId: String, val publisher: String, val appId: String, val eventId: String,
    val version: String, val htmlHash: String, val handle: String,
    val configuration: CapabilityConfiguration?
  )

  fun startPublishedArtifact(raw: String) {
    if (disposed) return
    if (sessionId != null) {
      if (raw != publishedSource) fail("session-reuse-blocked")
      return
    }
    val claims = parsePublishedClaims(raw) ?: run { fail("invalid-session"); return }
    sessionId = claims.sessionId
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      fail("webview-update-required"); return
    }
    val claimed = PublishedArtifactTransfer.INSTANCE.claimForHost(
      claims.handle, claims.sessionId, claims.publisher, claims.appId, claims.eventId,
      claims.version, claims.htmlHash, generation)
    val bytes = claimed?.takeHtmlBytes()
    if (bytes == null) { fail("artifact-claim-failed"); return }
    val config = claims.configuration
    if (config != null) {
      if (!CapabilityTransport.leases.register(generation)) { fail("capability-unavailable"); return }
      if (!ApprovalTransport.register(generation)) { fail("approval-unavailable"); return }
      if (!RoutingTransport.register(generation, config)) { fail("routing-unavailable"); return }
      if (!LinkTransport.register(generation, config)) { fail("link-unavailable"); return }
      if (!UploadTransport.register(generation, config)) { fail("upload-unavailable"); return }
      configuration = config
      ApprovalTransport.focus(generation, active)
    UploadTransport.focus(generation, active)
    RoutingTransport.focus(generation, active)
    LinkTransport.focus(generation, active)
    }
    published = claims
    publishedSource = raw
    publishedReader = PublishedArtifactReadOwner(bytes)
    live = true
    expectedUrl = "$ORIGIN/assets/runtime/index.html?sessionId=$generation&source=published"
    webView.loadUrl(expectedUrl!!)
    webView.postDelayed({ if (live && !ready) fail("readiness-timeout") }, 15000)
  }

  private fun parsePublishedClaims(raw: String): PublishedClaims? {
    if (raw.toByteArray(Charsets.UTF_8).size > 2048) return null
    return try {
      val data = JSONObject(raw)
      val required = setOf("sessionId", "publisher", "appId", "eventId", "version", "htmlHash", "handle")
      val names = data.keys().asSequence().toSet()
      if (names != required && names != required + "configuration") return null
      val values = listOf("sessionId", "publisher", "appId", "eventId", "version", "htmlHash", "handle")
        .map { data.get(it) as? String ?: return null }
      val session = values[0]
      if (!session.matches(Regex("[A-Za-z0-9_-]{1,80}")) ||
          !PublishedArtifactRegistry.validClaims(values[1], values[2], values[3], values[4], values[5]) ||
          !values[6].matches(Regex("[0-9a-f]{64}"))) return null
      val config = if (names.contains("configuration")) {
        val rawConfig = data.get("configuration") as? String ?: return null
        val parsed = CapabilityConfiguration(rawConfig, generation, allowPublished = true)
        if (!PublishedCapabilityBinding.matches(parsed.fixture, parsed.sessionId,
            parsed.publisher, parsed.appId, parsed.version, session, values[1], values[2], values[4])) return null
        parsed
      } else null
      PublishedClaims(session, values[1], values[2], values[3], values[4], values[5], values[6], config)
    } catch (_: Exception) { null }
  }

  private fun receivePublishedRead(data: JSONObject): PublishedArtifactReadOwner.Chunk? {
    if (data.keys().asSequence().toSet() != setOf("type", "sessionId", "sequence")) return null
    val number = data.get("sequence")
    if (number !is Int && number !is Long) return null
    val sequence = (number as Number).toLong()
    if (sequence < 0 || sequence > Int.MAX_VALUE) return null
    return publishedReader?.read(sequence.toInt())
  }

  private fun receiveStreamAck(data: JSONObject) {
    if (!ready || data.keys().asSequence().toSet() != setOf("type", "sessionId", "sequence", "streamSequence", "delivery")) return
    val values = listOf("sequence", "streamSequence", "delivery").map { name ->
      val value = data.opt(name)
      if (value !is Int && value !is Long) return
      (value as Number).toLong().takeIf { it in 1..9_007_199_254_740_991L } ?: return
    }
    if (!CapabilityTransport.leases.consumeSequence(generation, values[0])) return
    RelaySubscriptionTransport.acknowledge(generation, values[1], values[2])
  }
  private fun receiveSubscription(data: JSONObject, push: (String) -> Unit) {
    val config = configuration ?: return
    if (!ready || data.keys().asSequence().toSet() != setOf("type", "sessionId", "sequence", "message")) return
    val number = data.opt("sequence")
    if (number !is Int && number !is Long) return
    val sequence = (number as Number).toLong()
    if (sequence !in 1..9_007_199_254_740_991L || !CapabilityTransport.leases.consumeSequence(generation, sequence)) return
    val message = data.opt("message") as? String ?: return
    val request = runCatching { UploadWire.objectValue(message, CapabilityLeaseRegistry.MAX_BYTES) }.getOrNull() ?: return
    val subId = request.opt("subId") as? String ?: return
    val id = request.opt("id") as? String ?: return
    val outbox = request.optString("type") == "outbox.subscribe"
    if (!config.allowsRelay || (if (outbox) !config.grantedDomains.contains("outbox") else request.optString("type") != "relay.subscribe") ||
      subId.isEmpty() || subId.toByteArray(Charsets.UTF_8).size > 128 || subId.any { it.code < 32 || it.code == 127 } ||
      id.isEmpty() || id.toByteArray(Charsets.UTF_8).size > 128 || message.toByteArray(Charsets.UTF_8).size > 16 * 1024) return
    val token = RelaySubscriptionTransport.admit(generation, sequence, config.request(message), subId, push, outbox) ?: return
    onHostEvent(mapOf("type" to "capability", "lane" to (if (outbox) "outbox-subscription" else "subscription"), "sessionId" to config.sessionId, "generation" to generation, "token" to token))
  }

  private fun receiveCapability(data: JSONObject, push: (String) -> Unit, replyRaw: (String?) -> Unit) {
    val config = configuration ?: return
    if (!ready || data.keys().asSequence().toSet() != setOf("type", "sessionId", "sequence", "message")) return
    val number = data.get("sequence")
    if ((number !is Int && number !is Long) || data.get("message") !is String) return
    val sequence = (number as Number).toLong()
    if (sequence !in 1..9_007_199_254_740_991L) return
    val message = data.getString("message")
    val operation = UUID.randomUUID().toString()
    val now = android.os.SystemClock.elapsedRealtime()
    pendingNativeReplies.entries.removeAll { it.value <= now }
    if (pendingNativeReplies.size < 64) pendingNativeReplies[operation] = now + 660000
    else closeUnsafeUntil = now + 660000
    val reply: (String?) -> Unit = { response -> pendingNativeReplies.remove(operation); replyRaw(response) }
    val request = runCatching { UploadWire.objectValue(message, CapabilityLeaseRegistry.MAX_BYTES, maximumDepth = 40) }.getOrNull()
    if (request?.optString("type") == "routing.call") {
      val token = RoutingTransport.receive(generation, sequence, message, push, reply) ?: return
      onHostEvent(mapOf("type" to "capability", "lane" to (if (request.optJSONObject("message")?.optString("type")?.startsWith("notify.") == true) "presentation" else if (request.optJSONObject("message")?.optString("type")?.startsWith("config.") == true) "configuration" else "routing"), "sessionId" to config.sessionId, "generation" to generation, "token" to token))
      return
    }
    if (!UploadJsonBounds.accepts(message, CapabilityLeaseRegistry.MAX_BYTES)) { reply(null); return }
    if (request?.optString("type") == "link.open") {
      if (!CapabilityTransport.leases.consumeSequence(generation, sequence)) { reply(null); return }
      LinkTransport.receive(generation, config, message, appContext.currentActivity, reply)
      return
    }
    if (request?.optString("type")?.startsWith("upload.") == true) {
      if (!CapabilityTransport.leases.consumeSequence(generation, sequence) || !config.allowsUpload) { reply(null); return }
      reply(UploadTransport.receive(generation, sequence, message, push) { token ->
        if (live && !disposed) onHostEvent(mapOf("type" to "capability", "lane" to "upload", "sessionId" to config.sessionId, "generation" to generation, "token" to token))
      })
      return
    }
    if (request != null && request.optString("type") in listOf("relay.publish", "outbox.publish")) {
      if (!CapabilityTransport.leases.consumeSequence(generation, sequence)) { reply(null); return }
      val id = request.opt("id") as? String
      if (!config.allowsRelay || (request.optString("type") == "outbox.publish" && "outbox" !in config.grantedDomains) || id == null || id.isEmpty() || id.toByteArray(Charsets.UTF_8).size > 128) { reply(null); return }
      val approval = ApprovalTransport.admit(generation, config.request(message), id, reply)
      if (approval == null) { reply(null); return }
      onHostEvent(mapOf("type" to "capability", "lane" to "approval", "sessionId" to config.sessionId, "generation" to generation, "token" to approval))
      return
    }
    val token = CapabilityTransport.admit(generation, sequence, config.request(message), reply)
    if (token == null) { reply(null); return }
    onHostEvent(mapOf("type" to "capability", "sessionId" to config.sessionId, "generation" to generation, "token" to token))
  }

  fun startSession(id: String) {
    if (disposed) return
    if (sessionId == id) return
    if (sessionId != null) { fail("session-reuse-blocked"); return }
    sessionId = id
    if (!id.matches(Regex("[A-Za-z0-9_-]{1,80}"))) { fail("invalid-session"); return }
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      fail("webview-update-required"); return
    }
    if (configuration != null && !CapabilityTransport.leases.register(generation)) { fail("capability-unavailable"); return }
    if (configuration != null && !ApprovalTransport.register(generation)) { fail("approval-unavailable"); return }
    ApprovalTransport.focus(generation, active)
    UploadTransport.focus(generation, active)
    RoutingTransport.focus(generation, active)
    LinkTransport.focus(generation, active)
    if (configuration != null && !RoutingTransport.register(generation, configuration!!)) { fail("routing-unavailable"); return }
    if (configuration != null && !LinkTransport.register(generation, configuration!!)) { fail("link-unavailable"); return }
    configuration?.let { if (!UploadTransport.register(generation, it)) { fail("upload-unavailable"); return } }
    UploadTransport.focus(generation, active)
    RoutingTransport.focus(generation, active)
    LinkTransport.focus(generation, active)
    live = true
    expectedUrl = "$ORIGIN/assets/runtime/index.html?sessionId=$generation"
    configuration?.let { expectedUrl += "&fixture=" + it.fixture }
    webView.loadUrl(expectedUrl!!)
    webView.postDelayed({ if (live && !ready) fail("readiness-timeout") }, 15000)
  }

  private fun emit(type: String, code: String? = null) {
    val payload = mutableMapOf<String, Any>("type" to type, "sessionId" to (sessionId ?: ""))
    if (type == "ready") payload["generation"] = generation
    if (code != null) payload["code"] = code
    onHostEvent(payload)
  }
  private fun maySelectFile(): Boolean = live && loaded && ready && !disposed && active &&
    configuration?.allowsUpload == true && UploadTransport.leases.isRegistered(generation)

  private fun fail(code: String) {
    if (disposed) return
    live = false
    publishedReader?.clear()
    SelectedFilePicker.revoke(generation)
    UploadTransport.revoke(generation)
    LinkTransport.revoke(generation)
    ApprovalTransport.revoke(generation)
    CapabilityTransport.leases.revoke(generation)
    emit("error", code)
    destroySession()
  }
  fun destroySession() {
    if (disposed) return
    disposed = true
    closeCheckId = null
    pendingNativeReplies.clear()
    live = false
    publishedReader?.clear()
    publishedReader = null
    synchronized(publishedViews) { publishedViews.remove(this) }
    SelectedFilePicker.revoke(generation)
    UploadTransport.revoke(generation)
    LinkTransport.revoke(generation)
    ApprovalTransport.revoke(generation)
    CapabilityTransport.revoke(generation)
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.removeWebMessageListener(webView, "HypergolicHost")
    }
    webView.stopLoading()
    removeView(webView)
    webView.destroy()
  }
  private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(byteArrayOf()))
  companion object {
    const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://appassets.androidplatform.net"
    private var mediaForeground = true
    fun setMediaForeground(foreground: Boolean) {
      mediaForeground = foreground
      val views = synchronized(publishedViews) { publishedViews.toList() }
      views.forEach { if (!foreground) it.closeCheckId = null; it.updateMediaPlayback() }
    }
    private val publishedViews = Collections.newSetFromMap(WeakHashMap<NappletHostView, Boolean>())
    fun revokePublishedOnBackground() {
      val views = synchronized(publishedViews) { publishedViews.toList() }
      views.forEach { if (it.published != null) it.fail("backgrounded") }
    }
  }
}
