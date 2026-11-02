package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Native-owned exact public review. No callback from JavaScript can approve this panel. */
public final class NativeReviewPanel {
  public static final String REQUESTER = "Trusted shell / Disposable signing trace";
  private final Handler main = new Handler(Looper.getMainLooper());
  private AlertDialog dialog;
  private volatile Runnable deny;
  private Runnable expiration;

  public void show(Activity activity, NativeSignerCore core, Object owner, NativeSignerCore.Review review,
      BooleanSupplier ownerActive, Consumer<String> completed) {
    show(activity,core,owner,review,REQUESTER,"Disposable local identity",java.util.Collections.emptyList(),ownerActive,() -> core.approveOnce(owner,review),completed);
  }
  public void show(Activity activity,NativeSignerCore core,Object owner,NativeSignerCore.Review review,
      String requester,String method,java.util.List<String> destinations,BooleanSupplier ownerActive,Supplier<String> approve,Consumer<String> completed) {
    showAsync(activity, core, owner, review, requester, method, destinations, ownerActive,
      done -> done.accept(approve.get()), completed);
  }
  public void showAsync(Activity activity, NativeSignerCore core, Object owner, NativeSignerCore.Review review,
      String requester, String method, java.util.List<String> destinations, BooleanSupplier ownerActive,
      Consumer<Consumer<String>> approve, Consumer<String> completed) {
    if (Looper.myLooper() != Looper.getMainLooper() || dialog != null || activity.isFinishing() || activity.isDestroyed() || !ownerActive.getAsBoolean() || !core.canReview(owner, review)) throw new NativeSignerCore.Denied();
    TextView details = new TextView(activity);
    int inset = (int)(20 * activity.getResources().getDisplayMetrics().density);
    details.setPadding(inset, inset, inset, inset); details.setTextSize(14); details.setTypeface(Typeface.MONOSPACE);
    details.setText("Requester\n" + requester + "\n\nSigning method\n" + method + "\n\nDestinations\n" + (destinations.isEmpty()?"None":String.join("\n",destinations)) + "\n\nAction\nSign this exact event once.\n\nEvent ID\n" + review.eventId() + "\n\nExact event\n" + review.unsignedEvent());
    ScrollView scroll = new ScrollView(activity); scroll.addView(details);
    boolean[] settled = {false}, dispatching = {false};
    Runnable finishDenied = () -> {
      if (settled[0]) return; settled[0] = true;
      try { core.reject(owner, review); } catch (NativeSignerCore.Denied ignored) {}
      if (expiration != null) main.removeCallbacks(expiration); expiration = null;
      AlertDialog current = dialog; dialog = null; deny = null;
      if (current != null) current.dismiss(); completed.accept(null);
    };
    deny = finishDenied;
    dialog = new AlertDialog.Builder(activity).setTitle("Review signing request").setView(scroll)
      .setPositiveButton("Approve once", null).setNegativeButton("Reject", (value, which) -> finishDenied.run()).create();
    dialog.setOnCancelListener(value -> finishDenied.run());
    dialog.setOnDismissListener(value -> { if (!settled[0]) finishDenied.run(); });
    dialog.show();
    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setFilterTouchesWhenObscured(true);
    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnTouchListener((view, event) ->
      (event.getFlags() & (MotionEvent.FLAG_WINDOW_IS_OBSCURED | MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED)) != 0);
    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
      if (settled[0]) return;
      if (!ownerActive.getAsBoolean() || activity.isFinishing() || activity.isDestroyed()) { finishDenied.run(); return; }
      if (dispatching[0]) return;
      dispatching[0] = true;
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
      Consumer<String> finish = result -> {
        Runnable delivery = () -> {
          if (settled[0]) return;
          if (result == null || !ownerActive.getAsBoolean()) { finishDenied.run(); return; }
          settled[0] = true;
          if (expiration != null) main.removeCallbacks(expiration);
          expiration = null;
          AlertDialog current = dialog;
          dialog = null;
          deny = null;
          if (current != null) current.dismiss();
          completed.accept(result);
        };
        if (Looper.myLooper() == Looper.getMainLooper()) delivery.run(); else main.post(delivery);
      };
      try { approve.accept(finish); } catch (RuntimeException failure) { finishDenied.run(); }
    });
    expiration = new Runnable() { public void run() {
      if(settled[0])return;
      if(!ownerActive.getAsBoolean() || !(dispatching[0] ? core.canFinish(owner,review) : core.canReview(owner,review)))finishDenied.run();else main.postDelayed(this,200);
    } };main.postDelayed(expiration,200);
  }
  public Runnable cancellation() {
    Runnable captured = deny;
    return () -> {
      if (captured == null) return;
      if (Looper.myLooper() == Looper.getMainLooper()) captured.run(); else main.post(captured);
    };
  }
  public void cancel() { cancellation().run(); }
}
