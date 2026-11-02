package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;

/** Native-only Activity correlation. Public results grant no identity, storage or source authority. */
final class NativeAndroidSignerActivityController {
  interface Completion { void complete(NativeAndroidSignerBinding binding, String value, String errorCode); }
  interface Launcher { void launch(Activity activity, Intent intent, int requestCode); }
  /** Opt-in native episode only; it grants receive preservation, never execution or storage authority. */
  interface Handoff {
    void start(String requestId, long deadline, NativeAndroidSignerBinding binding);
    boolean current(String requestId, long deadline);
    void dispatched();
    void cancel();
  }
  private static final long MAX_LIFETIME_MS = 120_000;
  private static final AtomicInteger NEXT_CODE = new AtomicInteger(44000);
  private final Object owner;
  private final BooleanSupplier live;
  private final LongSupplier elapsed;
  private final Launcher launcher;
  private final Runnable beforeSelectionRequest;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final NativeAndroidSignerPicker picker = new NativeAndroidSignerPicker();
  private volatile Request pending;
  private volatile boolean foreground = true;

  private static final class Request {
    final Activity activity;
    final NativeAndroidSignerBinding binding;
    final NativeEvent event;
    final String id = UUID.randomUUID().toString();
    final int code;
    final long deadline;
    final Completion completion;
    final Handoff handoff;
    Runnable poll;
    volatile boolean cancelled, consumed;
    final AtomicBoolean handoffCancelled = new AtomicBoolean();
    Request(Activity activity, NativeAndroidSignerBinding binding, NativeEvent event,
        long deadline, Completion completion, Handoff handoff) {
      this.handoff = handoff;
      this.activity = activity;
      this.binding = binding;
      this.event = event;
      this.code = NEXT_CODE.getAndUpdate(value -> value < 65536 ? value + 1 : value);
      if (code > 65535) throw new NativeVault.Error("SIGNER_UNSUPPORTED");
      this.deadline = deadline;
      this.completion = completion;
    }
  }

  // The native owning module supplies its actual AppContext and claimed-owner/lifecycle check.
  NativeAndroidSignerActivityController(Object owner, BooleanSupplier live) {
    this(owner, live, SystemClock::elapsedRealtime, Activity::startActivityForResult);
  }

  /** Native test clock/launch port only. No bridge can construct this component or supply these values. */
  NativeAndroidSignerActivityController(Object owner, BooleanSupplier live, LongSupplier elapsed, Launcher launcher) {
    this(owner, live, elapsed, launcher, () -> {});
  }

  /** Deterministic native test seam at the picker-to-request liveness boundary. */
  NativeAndroidSignerActivityController(Object owner, BooleanSupplier live, LongSupplier elapsed, Launcher launcher, Runnable beforeSelectionRequest) {
    if (owner == null || live == null || elapsed == null || launcher == null || beforeSelectionRequest == null) throw denied();
    this.owner = owner;
    this.live = live;
    this.elapsed = elapsed;
    this.launcher = launcher;
    this.beforeSelectionRequest = beforeSelectionRequest;
  }

  void choosePublicKey(Activity activity, Object context, long deadline, Completion completion) {
    choosePublicKeyScoped(activity, context, deadline, completion, null);
  }

  void choosePublicKeyScoped(Activity activity, Object context, long deadline, Completion completion, Handoff handoff) {
    onMain();
    requireStart(activity, context, deadline);
    AtomicBoolean delivered = new AtomicBoolean();
    Completion once = (binding, value, error) -> {
      if (delivered.compareAndSet(false, true)) completion.complete(binding, value, error);
    };
    picker.show(activity, deadline, () -> available(activity), (binding, error) -> {
      if (binding == null) once.complete(null, null, error);
      else {
        try {
          beforeSelectionRequest.run();
          requestScoped(activity, context, binding, null, deadline, once, handoff);
        } catch (Exception failure) { once.complete(binding, null, code(failure, "AUTHORIZATION_DENIED")); }
      }
    });
  }

  /** A future native source/vault caller owns signing consent and selected-method authority. */
  void requestSignature(Activity activity, Object context, NativeAndroidSignerBinding binding,
      NativeEvent event, long deadline, Completion completion) {
    if (event == null) throw denied();
    request(activity, context, binding, event, deadline, completion);
  }

  void requestSignatureScoped(Activity activity, Object context, NativeAndroidSignerBinding binding,
      NativeEvent event, long deadline, Completion completion, Handoff handoff) {
    if (event == null || handoff == null) throw denied();
    requestScoped(activity, context, binding, event, deadline, completion, handoff);
  }

  // Package-private for owning tests; production lookup selection goes through the native picker above.
  void request(Activity activity, Object context, NativeAndroidSignerBinding binding, NativeEvent event,
      long deadline, Completion completion) {
    requestScoped(activity, context, binding, event, deadline, completion, null);
  }

  private void requestScoped(Activity activity, Object context, NativeAndroidSignerBinding binding, NativeEvent event,
      long deadline, Completion completion, Handoff handoff) {
    onMain();
    requireStart(activity, context, deadline);
    if (binding == null || completion == null) throw denied();
    NativeEvent frozen = event == null ? null : NativeEvent.capture(event.unsigned, event.pubkey);
    Request entry = new Request(activity, binding, frozen, deadline, completion, handoff);
    pending = entry;
    entry.poll = () -> {
      if (pending != entry) return;
      if (!current(entry)) finish(entry, null, "AUTHORIZATION_DENIED");
      else main.postDelayed(entry.poll, 200);
    };
    try {
      Intent intent = frozen == null ? NativeAndroidSignerParcel.publicKey(binding, entry.id)
          : NativeAndroidSignerParcel.sign(binding, entry.id, frozen);
      NativeAndroidSignerInventory.requireCurrent(activity, binding);
      // Re-measure the complete final Intent after construction and immediately before dispatch.
      NativeAndroidSignerParcel.bounded(intent, "SIGNER_UNSUPPORTED");
      if (!available(activity)) throw denied();
      if (handoff != null) handoff.start(entry.id, deadline, binding);
      if (!current(entry)) throw denied();
      if (handoff != null) handoff.dispatched();
      launcher.launch(activity, intent, entry.code);
      if (pending == entry) main.post(entry.poll);
    } catch (Exception failure) {
      finish(entry, null, code(failure, "SIGNER_APP_FAILED"));
    }
  }

  void result(Activity activity, Object context, int requestCode, int resultCode, Intent data) {
    onMain();
    Request entry = pending;
    if (entry == null || entry.consumed || context != owner || activity != entry.activity || requestCode != entry.code) return;
    // Consume before parsing or callback. Replays can never satisfy a later request.
    entry.consumed = true;
    main.removeCallbacks(entry.poll);
    String value = null, error = null;
    try {
      if (!currentAfterConsume(entry)) throw denied();
      NativeAndroidSignerInventory.requireCurrent(activity, entry.binding);
      value = entry.event == null
          ? NativeAndroidSignerResult.publicKey(data, resultCode, entry.id, entry.binding)
          : NativeAndroidSignerResult.signedEvent(data, resultCode, entry.id, entry.event);
      NativeAndroidSignerInventory.requireCurrent(activity, entry.binding);
      if (!currentAfterConsume(entry)) throw denied();
    } catch (Exception failure) {
      value = null;
      error = code(failure, "SIGNER_RESPONSE_INVALID");
    }
    finish(entry, value, error);
  }

  void foreground(boolean active) {
    foreground = active;
    Request entry = pending;
    if (!active && (entry == null || entry.handoff == null || !current(entry))) cancel();
    if (!active) picker.cancel();
  }
  void destroyed(Activity activity) {
    Request entry = pending;
    if (entry != null && entry.activity == activity) cancel(entry);
    picker.destroyed(activity);
  }
  Runnable cancellation() {
    Request entry = pending;
    Runnable cancelPicker = picker.cancellation();
    return () -> { cancel(entry); cancelPicker.run(); };
  }
  void cancel() { cancellation().run(); }
  private static void cancelHandoff(Request entry) {
    if (entry.handoff != null && entry.handoffCancelled.compareAndSet(false, true)) entry.handoff.cancel();
  }
  private void cancel(Request entry) {
    if (entry == null) return;
    entry.cancelled = true;
    cancelHandoff(entry);
    if (Looper.myLooper() == Looper.getMainLooper()) finish(entry, null, "AUTHORIZATION_DENIED");
    else main.post(() -> finish(entry, null, "AUTHORIZATION_DENIED"));
  }
  private void requireStart(Activity activity, Object context, long deadline) {
    long now = elapsed.getAsLong();
    if (context != owner || pending != null || picker.busy() || !available(activity) ||
        now < 0 || now > Long.MAX_VALUE - MAX_LIFETIME_MS || deadline <= now || deadline > now + MAX_LIFETIME_MS) throw denied();
  }
  private boolean available(Activity activity) {
    try { return foreground && activity != null && !activity.isFinishing() && !activity.isDestroyed() && live.getAsBoolean(); }
    catch (Exception failure) { return false; }
  }
  private boolean current(Request entry) { return pending == entry && currentAfterConsume(entry); }
  private boolean currentAfterConsume(Request entry) {
    try {
      long now = elapsed.getAsLong();
      if (pending != entry || entry.cancelled || now < 0 || now >= entry.deadline || entry.activity.isFinishing() || entry.activity.isDestroyed()) return false;
      return entry.handoff == null ? available(entry.activity) : entry.handoff.current(entry.id, entry.deadline);
    }
    catch (Exception failure) { return false; }
  }
  private void finish(Request entry, String value, String error) {
    if (pending != entry) return;
    pending = null;
    main.removeCallbacks(entry.poll);
    if (error != null) cancelHandoff(entry);
    entry.completion.complete(entry.binding, value, error);
  }
  private static String code(Exception failure, String fallback) {
    return failure instanceof NativeVault.Error ? ((NativeVault.Error) failure).code : fallback;
  }
  private static NativeVault.Error denied() { return new NativeVault.Error("AUTHORIZATION_DENIED"); }
  private static void onMain() {
    if (Looper.myLooper() != Looper.getMainLooper()) throw denied();
  }
}
