package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.widget.Button;
import android.widget.LinearLayout;
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
  public interface Confirmation {
    void confirm(Consumer<Boolean> completed);
  }
  public void showAsync(Activity activity, NativeSignerCore core, Object owner, NativeSignerCore.Review review,
      String requester, String method, java.util.List<String> destinations, BooleanSupplier ownerActive,
      Consumer<Consumer<String>> approve, Consumer<String> completed) {
    showConfirmed(activity, core, owner, review, requester, method, destinations, ownerActive,
      callback -> callback.accept(true), approve, completed);
  }
  public void showConfirmed(Activity activity, NativeSignerCore core, Object owner, NativeSignerCore.Review review,
      String requester, String method, java.util.List<String> destinations, BooleanSupplier ownerActive,
      Confirmation confirmation, Consumer<Consumer<String>> approve, Consumer<String> completed) {
    if (Looper.myLooper() != Looper.getMainLooper() || dialog != null || activity.isFinishing() || activity.isDestroyed() || !ownerActive.getAsBoolean() || !core.canReview(owner, review)) throw new NativeSignerCore.Denied();
    TextView details = new TextView(activity);
    int inset = (int)(20 * activity.getResources().getDisplayMetrics().density);
    details.setTextSize(14); details.setTypeface(Typeface.MONOSPACE);
    details.setText("Requester\n" + requester + "\n\nSigning method\n" + method + "\n\nDestinations\n" + (destinations.isEmpty()?"None":String.join("\n",destinations)) + "\n\nAction\nSign this exact event once.\n\nEvent ID\n" + review.eventId() + "\n\nExact event");
    LinearLayout content = new LinearLayout(activity);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setPadding(inset, inset, inset, inset);
    content.addView(details);
    content.addView(new EventPages(activity, review.unsignedEvent()));
    ScrollView scroll = new ScrollView(activity); scroll.addView(content);
    boolean[] settled = {false}, dispatching = {false}, confirming = {false};
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
      if (dispatching[0] || confirming[0]) return;
      confirming[0] = true;
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
      confirmation.confirm(accepted -> {
        if (settled[0] || !confirming[0]) return;
        confirming[0] = false;
        if (!accepted || !ownerActive.getAsBoolean() || !core.canReview(owner, review)) { finishDenied.run(); return; }
        dispatching[0] = true;
        try { approve.accept(finish); } catch (RuntimeException failure) { finishDenied.run(); }
      });
    });
    expiration = new Runnable() { public void run() {
      if(settled[0])return;
      if(!ownerActive.getAsBoolean() || !(dispatching[0] ? core.canFinish(owner,review) : core.canReview(owner,review)))finishDenied.run();else main.postDelayed(this,200);
    } };main.postDelayed(expiration,200);
  }
  private static final class EventPages extends LinearLayout {
    private static final int PAGE_SIZE = 4096;
    private final String text;
    private final int count;
    private final TextView event;
    private final TextView label;
    private final Button previous;
    private final Button next;
    private int page;

    EventPages(Activity activity, String text) {
      super(activity);
      this.text = text;
      count = Math.max(1, (text.length() + PAGE_SIZE - 1) / PAGE_SIZE);
      setOrientation(VERTICAL);
      previous = new Button(activity);
      next = new Button(activity);
      label = new TextView(activity);
      if (count > 1) {
        previous.setText("Previous page");
        previous.setOnClickListener(view -> show(page - 1));
        next.setText("Next page");
        next.setOnClickListener(view -> show(page + 1));
        label.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        addView(label);
        addView(previous);
        addView(next);
      }
      event = new TextView(activity);
      event.setTextSize(14);
      event.setTypeface(Typeface.MONOSPACE);
      event.setTextIsSelectable(true);
      addView(event);
      show(0);
    }

    private int boundary(int offset) {
      if (offset >= text.length()) return text.length();
      return offset > 0 && Character.isSurrogatePair(text.charAt(offset - 1), text.charAt(offset)) ? offset - 1 : offset;
    }

    private void show(int index) {
      page = index;
      event.setText(text.substring(boundary(page * PAGE_SIZE), boundary((page + 1) * PAGE_SIZE)));
      label.setText("Page " + (page + 1) + " of " + count);
      previous.setEnabled(page > 0);
      next.setEnabled(page + 1 < count);
    }
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
