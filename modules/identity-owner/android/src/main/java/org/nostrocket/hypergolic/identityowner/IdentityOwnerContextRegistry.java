package org.nostrocket.hypergolic.identityowner;

import java.lang.ref.WeakReference;

/** Native-created main AppContext identity only. No reset and no caller-selected runtime identifier. */
final class IdentityOwnerContextRegistry {
  private boolean consumed, retired;
  private WeakReference<Object> owner = new WeakReference<>(null);
  private Runnable revocation;

  synchronized boolean claim(Object context, boolean onMainJavaScriptThread) {
    if (consumed || retired) { retire(); return false; }
    consumed = true;
    if (context == null || !onMainJavaScriptThread) { retire(); return false; }
    owner = new WeakReference<>(context);
    return true;
  }
  synchronized boolean owns(Object context) {
    return consumed && !retired && context != null && owner.get() == context;
  }
  synchronized boolean register(Object context, Runnable revoke) {
    if (!owns(context) || revoke == null || revocation != null) return false;
    revocation = revoke;
    return true;
  }
  synchronized void retireIfOwned(Object context) { if (owns(context)) retire(); }
  private void retire() {
    retired = true;
    owner.clear();
    Runnable effect = revocation;
    revocation = null;
    // The callback only revokes the authority/prompt; it never calls this registry.
    if (effect != null) effect.run();
  }
}
