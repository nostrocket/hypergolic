package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import java.util.List;
import java.util.function.BooleanSupplier;

/** Native installed-package choice; labels are display data, current certificate sets bind identity. */
final class NativeAndroidSignerPicker {
  interface Completion { void complete(NativeAndroidSignerBinding selected, String errorCode); }
  private final Handler main = new Handler(Looper.getMainLooper());
  private volatile Choice current;
  private static final class Choice {
    final Activity activity;
    final AlertDialog dialog;
    final long deadline;
    final BooleanSupplier live;
    final Completion completion;
    Runnable poll;
    volatile boolean cancelled;
    Choice(Activity activity, AlertDialog dialog, long deadline, BooleanSupplier live, Completion completion) {
      this.activity = activity; this.dialog = dialog; this.deadline = deadline;
      this.live = live; this.completion = completion;
    }
  }
  boolean busy() { return current != null; }
  void show(Activity activity, long deadline, BooleanSupplier live, Completion completion) {
    if (Looper.myLooper() != Looper.getMainLooper() || current != null) throw new NativeVault.Error("AUTHORIZATION_DENIED");
    List<NativeAndroidSignerBinding> installed = NativeAndroidSignerInventory.installed(activity);
    if (installed.isEmpty()) throw new NativeVault.Error("SIGNER_UNAVAILABLE");
    String[] names = installed.stream().map(value -> value.packageName + "\nSHA-256:\n" +
        String.join("\n", value.certificateSha256s)).toArray(String[]::new);
    AlertDialog dialog = new AlertDialog.Builder(activity).setTitle("Choose Android signer")
        .setItems(names, null).setNegativeButton("Cancel", null).create();
    Choice entry = new Choice(activity, dialog, deadline, live, completion);
    current = entry;
    entry.poll = () -> {
      if (current != entry) return;
      if (!valid(entry)) finish(entry, null, "AUTHORIZATION_DENIED");
      else main.postDelayed(entry.poll, 200);
    };
    dialog.setOnCancelListener(ignored -> finish(entry, null, "AUTHORIZATION_DENIED"));
    dialog.setOnDismissListener(ignored -> finish(entry, null, "AUTHORIZATION_DENIED"));
    try {
      dialog.show();
      dialog.getListView().setFilterTouchesWhenObscured(true);
      dialog.getListView().setOnTouchListener((view, event) ->
          (event.getFlags() & (MotionEvent.FLAG_WINDOW_IS_OBSCURED | MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED)) != 0);
      dialog.getListView().setOnItemClickListener((parent, view, position, id) -> {
        if (!valid(entry)) { finish(entry, null, "AUTHORIZATION_DENIED"); return; }
        NativeAndroidSignerBinding selected = installed.get(position);
        try {
          NativeAndroidSignerInventory.requireCurrent(activity, selected);
          if (!valid(entry)) throw new NativeVault.Error("AUTHORIZATION_DENIED");
          finish(entry, selected, null);
        } catch (NativeVault.Error failure) { finish(entry, null, failure.code); }
      });
      dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener(view -> finish(entry, null, "AUTHORIZATION_DENIED"));
      main.post(entry.poll);
    } catch (Exception failure) { finish(entry, null, "AUTHORIZATION_DENIED"); }
  }
  void destroyed(Activity activity) { Choice entry = current; if (entry != null && entry.activity == activity) cancel(entry); }
  void cancel() { cancellation().run(); }
  Runnable cancellation() { Choice entry = current; return () -> cancel(entry); }
  private void cancel(Choice entry) {
    if (entry == null) return;
    entry.cancelled = true;
    if (Looper.myLooper() == Looper.getMainLooper()) finish(entry, null, "AUTHORIZATION_DENIED");
    else main.post(() -> finish(entry, null, "AUTHORIZATION_DENIED"));
  }
  private boolean valid(Choice entry) {
    try { return current == entry && !entry.cancelled && !entry.activity.isDestroyed() && !entry.activity.isFinishing() &&
        SystemClock.elapsedRealtime() < entry.deadline && entry.live.getAsBoolean(); }
    catch (Exception failure) { return false; }
  }
  private void finish(Choice entry, NativeAndroidSignerBinding binding, String error) {
    if (current != entry) return;
    current = null;
    main.removeCallbacks(entry.poll);
    entry.dialog.setOnDismissListener(null);
    entry.dialog.dismiss();
    entry.completion.complete(binding, error);
  }
}
