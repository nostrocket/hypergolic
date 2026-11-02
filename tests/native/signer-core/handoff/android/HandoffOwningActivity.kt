package org.nostrocket.hypergolic.signercore

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.nostrocket.hypergolic.host.HandoffSourceFixture
import org.nostrocket.hypergolic.host.HandoffFixtureSource
import org.nostrocket.hypergolic.host.FixtureHandoffCancellationProof
import org.nostrocket.hypergolic.host.NativeSignerRelayFixture

/** Actual native controller/source/client; native owner, browser, gesture and local TLS policy ports are doubles. */
class HandoffOwningActivity : Activity() {
  private val main = Handler(Looper.getMainLooper())
  private val owner = Any()
  private var foreground = true
  private var assertions = 0
  private val results = JSONArray()
  private lateinit var ready: JSONObject
  private lateinit var certificate: ByteArray
  private val platform = TestPlatform()
  private lateinit var controller: NativeHandoffController
  private fun check(value: Boolean) { assertions++; check(value) { "Owning handoff assertion $assertions" } }
  private inner class TestPlatform : NativeHandoffController.Platform {
    var open: (() -> Unit)? = null
    var prompts = 0
    var beforeResumeAccept: (() -> Unit)? = null
    val receivers = mutableListOf<() -> Unit>()
    override fun activity(): Activity = this@HandoffOwningActivity
    override fun unlocked() = true
    override fun validate(raw: String, cancelled: () -> Boolean, deadline: Long) = "https://example.org"
    override fun browser(activity: Activity) = "native-test-browser-port"
    override fun launch(activity: Activity, raw: String, browser: String) { open?.invoke() }
    override suspend fun confirm(activity: Activity, title: String, detail: String, button: String, valid: () -> Boolean): Boolean {
      if (button == "Resume") prompts++
      val admitted = valid()
      if (button == "Resume") beforeResumeAccept?.invoke()
      return admitted
    }
    override fun cancelPrompt() {}
    override fun watchLock(activity: Activity, revoke: () -> Unit): () -> Unit {
      receivers.add(revoke)
      return { receivers.remove(revoke); Unit }
    }
  }
  override fun onCreate(saved: Bundle?) {
    super.onCreate(saved)
    controller = NativeHandoffController(owner, { foreground }, platform)
    CoroutineScope(Dispatchers.Main.immediate).launch {
      try {
        ready = JSONObject(assets.open("fixture.json").bufferedReader().use { it.readText() })
        certificate = assets.open("fixture.der").use { it.readBytes() }
        race()
        sourceGate()
        completedSources()
        val fixtures = FixtureHandoffCancellationProof.run(); check(fixtures >= 20)
        withContext(Dispatchers.IO) { rpc() }
        write("passed", null)
      } catch (failure: Throwable) { write("failed", failure.javaClass.simpleName + ":" + failure.message) }
    }
  }
  private suspend fun race() {
    val entered = CountDownLatch(1); val release = CountDownLatch(1)
    val aCancels = AtomicInteger(); val bCancels = AtomicInteger()
    val deadline = SystemClock.elapsedRealtime() + 10000
    val a = controller.authorization(NativeHandoffController.Binding.Preparation("public-vault", 1, "a", "connect"), 1, deadline,
      NativeHandoffController.Checks({ true }, { true }, { aCancels.incrementAndGet(); entered.countDown(); check(release.await(2, TimeUnit.SECONDS)) }))
    a.beginActivity("request-a")
    val oldReceiver = platform.receivers.last()
    val lateCancel = controller.cancellation()
    val first = Thread { a.discard() }; first.start()
    check(withContext(Dispatchers.IO) { entered.await(2, TimeUnit.SECONDS) })
    val second = Thread { a.discard() }; second.start()
    withContext(Dispatchers.IO) { second.join(1000) }; check(!second.isAlive)
    val b = controller.authorization(NativeHandoffController.Binding.Preparation("public-vault", 1, "b", "connect"), 2, deadline,
      NativeHandoffController.Checks({ true }, { true }, { bCancels.incrementAndGet() }))
    b.beginActivity("request-b")
    oldReceiver(); lateCancel(); controller.complete(a)
    check(b.activityCurrent("request-b", deadline)); check(aCancels.get() == 1 && bCancels.get() == 0)
    release.countDown(); withContext(Dispatchers.IO) { first.join(1000) }
    check(!first.isAlive); check(b.activityCurrent("request-b", deadline)); check(!a.receive())
    controller.complete(b) // Preparation completion must detach even after the owning row is removed.
    check(controller.preparationState("public-vault", 1, "b") == null); check(bCancels.get() == 0)
  }
  private suspend fun sourceGate() {
    val event = event()
    val source = HandoffSourceFixture(event.pubkey, event.unsigned)
    val auth = controller.authorization(NativeHandoffController.Binding.Signing("approval", source.token, source.capture), 7,
      SystemClock.elapsedRealtime() + 10000, NativeHandoffController.Checks({ source.approved() }, { true }, source::cancel))
    auth.beginActivity("source-request")
    source.foreground(false); foreground = false; check(controller.background())
    source.foreground(true); foreground = true; controller.foreground()
    check(!auth.execute()); check(!source.approved()); check(source.restores.get() == 0)
    withContext(Dispatchers.IO) { auth.awaitResume("source-request") }
    check(auth.execute()); check(source.restores.get() == 1 && source.approved())
    controller.complete(auth)
    check(!auth.execute()); check(controller.signingState("approval", source.token) == "resumed")
    check(source.cancels.get() == 0)
    source.cancel(); check(controller.signingState("approval", source.token) == null)
    val lockedSource = HandoffSourceFixture(event.pubkey, event.unsigned)
    val locked = controller.authorization(NativeHandoffController.Binding.Signing("approval", lockedSource.token, lockedSource.capture), 8,
      SystemClock.elapsedRealtime() + 10000, NativeHandoffController.Checks({ lockedSource.approved() }, { true }, lockedSource::cancel))
    locked.beginActivity("locked-request"); platform.receivers.last().invoke()
    check(!locked.receive()); check(lockedSource.cancels.get() == 1); check(lockedSource.restores.get() == 0)
  }
  private suspend fun completedSources() {
    val tracker = NativeCompletedSignings()
    val expected = event()
    val a = HandoffSourceFixture(expected.pubkey, expected.unsigned)
    val b = HandoffFixtureSource(expected.pubkey, expected.unsigned)
    tracker.record("approval", a.token, a.capture); tracker.record("fixture-upload", b.token, b.capture)
    check(a.approved() && b.approved())
    val old = tracker.cancellation()
    a.cancel() // Native approval policy has one active grant; old cleanup must still leave replacement C intact.
    val c = HandoffSourceFixture(expected.pubkey, expected.unsigned)
    tracker.record("approval", c.token, c.capture); old()
    check(!a.approved() && !b.approved() && c.approved())
    tracker.cancellation()(); check(!c.approved())
    val protectedA = HandoffSourceFixture(expected.pubkey, expected.unsigned)
    val protectedB = HandoffFixtureSource(expected.pubkey, expected.unsigned)
    tracker.record("approval", protectedA.token, protectedA.capture); tracker.record("fixture-upload", protectedB.token, protectedB.capture)
    tracker.cancellation()(); check(!protectedA.approved() && !protectedB.approved())
    val oldStage = HandoffFixtureSource(expected.pubkey, expected.unsigned)
    tracker.record("fixture-upload", oldStage.token, oldStage.capture); oldStage.nextManifest()
    tracker.cancellation()(); check(oldStage.manifestApproved()); oldStage.cancelManifest()
    repeat(32) { tracker.record("approval", "expired-$it", c.capture) }
    tracker.ensureCapacity() // Prunes only the inactive captured sources outside tracker lock.
    val fresh = HandoffSourceFixture(expected.pubkey, expected.unsigned)
    repeat(32) { tracker.record("approval", fresh.token, fresh.capture) }
    var denied = false
    try { tracker.ensureCapacity() } catch (failure: NativeVault.Error) { denied = true }
    check(denied); tracker.cancellation()(); check(!fresh.approved())
    val stale = HandoffSourceFixture(expected.pubkey, expected.unsigned)
    var captured = true
    val auth = controller.authorization(NativeHandoffController.Binding.Signing("approval", stale.token, stale.capture), 8,
      SystemClock.elapsedRealtime() + 10000, NativeHandoffController.Checks({ stale.approved() }, { captured }, stale::cancel))
    auth.beginActivity("freshness-request"); stale.foreground(false); foreground = false; controller.background()
    stale.foreground(true); foreground = true; controller.foreground()
    platform.beforeResumeAccept = { captured = false }
    var rejected = false
    try { withContext(Dispatchers.IO) { auth.awaitResume("freshness-request") } }
    catch (failure: NativeVault.Error) { rejected = true }
    platform.beforeResumeAccept = null
    check(rejected && stale.restores.get() == 0 && !stale.approved())
  }
  private fun event(): NativeEvent = NativeEvent.capture(JSONObject().put("pubkey", ready.getString("userPubkey"))
    .put("created_at", 1).put("kind", 1).put("tags", JSONArray()).put("content", "Disposable handoff exact event").toString(), ready.getString("userPubkey"))
  private fun control(body: JSONObject) {
    val uri = URI(ready.getString("controlURL")); check(uri.host == "127.0.0.1" && uri.scheme == "http")
    val connection = uri.toURL().openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 2000; connection.readTimeout = 2000; connection.requestMethod = "POST"; connection.doOutput = true
      connection.setRequestProperty("content-type", "application/json"); connection.setRequestProperty("x-fixture-control", ready.getString("nonce"))
      connection.outputStream.use { it.write(body.toString().toByteArray()) }
      check(connection.responseCode == 200)
    } finally { connection.disconnect() }
  }
  private suspend fun rpc() {
    val cases = listOf("valid", "changed-event", "refusal", "missing", "wrong-public-key", "changed-relays")
    control(JSONObject().put("fault", "none").put("relays", JSONObject.NULL))
    val chars = ready.getString("bunkerURL").toCharArray()
    val entry = try { NativeBunker.parse(chars) } finally { chars.fill('\u0000') }
    val binding = NativeRemoteBinding(NativeSigningKey(), entry.peer, entry.relays)
    val bootstrap = NativeRemoteOperation(SystemClock.elapsedRealtime() + 8000, object : NativeRemoteOperation.Guard {
      override fun check() {}
      override fun beforeSigningSend() { throw NativeVault.Error("AUTHORIZATION_DENIED") }
    })
    try {
      NativeNip46Client(binding, bootstrap) { url, transport, budget ->
        NativeSignerRelayFixture.open(url, transport, transport.deadline, budget, certificate)
      }.use { check(it.connect(entry.secret) == ready.getString("userPubkey")) }
    } finally { bootstrap.close(); entry.close() }
    for (fault in cases) {
      val method = when (fault) { "wrong-public-key" -> "get_public_key"; "changed-relays" -> "switch_relays"; else -> "sign_event" }
      control(JSONObject().put("fault", "auth-url").put("method", method).put("authURL", "https://example.org/?fixture=public-disposable").put("relays", JSONObject.NULL))
      val expected = event()
      val source = HandoffSourceFixture(expected.pubkey, expected.unsigned)
      var auth: NativeHandoffController.Authorization? = null
      val deadline = SystemClock.elapsedRealtime() + if (fault == "missing") 2500 else 8000
      val operation = NativeRemoteOperation(deadline, object : NativeRemoteOperation.Guard {
        override fun check() { if (auth?.receive() == false) throw NativeVault.Error("AUTHORIZATION_DENIED") }
        override fun execute() { if (auth?.execute() == false) throw NativeVault.Error("AUTHORIZATION_DENIED") }
        override fun beforeSigningSend() = execute()
      })
      auth = controller.authorization(NativeHandoffController.Binding.Signing("approval", source.token, source.capture), 20,
        deadline, NativeHandoffController.Checks({ source.approved() }, { true }, source::cancel))
      val exact = auth
      val confirmsBefore = platform.prompts
      withContext(Dispatchers.Main.immediate) {
        platform.open = {
          source.foreground(false); foreground = false; controller.background()
          Thread {
            try {
              if (fault != "missing") {
                val responseFault = when (fault) { "changed-event", "wrong-public-key" -> fault; else -> "none" }
                val done = JSONObject().put("fault", responseFault).put("method", method)
                  .put("completeAuth", JSONObject().put("clientPubkey", binding.client.publicKey()).put("id", exact.ticket!!.requestId)
                    .put("decision", if (fault == "refusal") "refuse" else "approve"))
                if (fault == "changed-relays") done.put("relays", JSONArray().put(ready.getString("changedRelayURL")))
                control(done)
              }
              main.post { source.foreground(true); foreground = true; controller.foreground() }
            } catch (failure: Throwable) { write("failed", failure.javaClass.simpleName + ":" + failure.message) }
          }.start()
        }
      }
      var value: String? = null; var code: String? = null
      try {
        NativeNip46Client(binding, operation) { url, transport, budget ->
          NativeSignerRelayFixture.open(url, transport, transport.deadline, budget, certificate)
        }.authorization(exact).use { value = it.sign(expected) }
      } catch (failure: NativeVault.Error) { code = failure.code }
      withContext(Dispatchers.Main.immediate) {
        if (fault == "valid") {
          check(value != null && code == null && source.restores.get() == 1)
          controller.complete(exact); check(controller.signingState("approval", source.token) == "resumed")
        } else {
          check(value == null); check(source.restores.get() == 0); check(platform.prompts == confirmsBefore)
          check(code != null); exact.discard(); check(!source.approved())
        }
        results.put(JSONObject().put("fault", fault).put("restores", source.restores.get()).put("error", code ?: JSONObject.NULL))
        source.cancel(); foreground = true; platform.open = null
      }
      operation.close()
    }
    binding.close()
  }
  private fun write(status: String, failure: String?) {
    val body = JSONObject().put("status", status).put("assertions", assertions).put("failure", failure ?: JSONObject.NULL).put("cases", results)
      .put("scope", "Owning actual Controller/source/Client with explicit owner, browser, gesture and loopback TLS ports. No production Expo or external browser trace.")
    File(filesDir, "result.json").outputStream().use { it.write(body.toString().toByteArray()) }
  }
}
