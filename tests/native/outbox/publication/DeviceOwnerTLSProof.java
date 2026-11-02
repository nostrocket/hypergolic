package org.nostrocket.hypergolic.host;

import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Physical boot-framework owner/transport proof; controlled route, pre-signed public event, shell UID. */
public final class DeviceOwnerTLSProof {
  private DeviceOwnerTLSProof() {}
  public static void main(String[] args) throws Exception {
    if (Build.VERSION.SDK_INT != 36 || Process.myUid() != 2000 || args.length < 5) throw new AssertionError("Unexpected runtime scope");
    ClassLoader boot = String.class.getClassLoader();
    for (Class<?> type : new Class<?>[] {JSONObject.class, JSONArray.class, JSONTokener.class, SystemClock.class, Handler.class, Looper.class}) {
      if (type.getClassLoader() != boot) throw new AssertionError("Runtime class is not supplied by Android: " + type.getName());
    }
    // The production approval registry constructs its main-thread Handler. No UI queue is driven here.
    if (Looper.myLooper() == null) Looper.class.getMethod("prepareMainLooper").invoke(null);
    System.out.println(new JSONObject().put("phase", "runtime").put("sdk", Build.VERSION.SDK_INT).put("uid", Process.myUid())
        .put("pid", Process.myPid()).put("model", Build.MODEL).put("frameworkJson", true).put("frameworkClockHandlerLooper", true)
        .put("scope", "Physical shell UID; test-only loopback route and public TLS anchor; no installed app, protected signer, guest or suspend proof"));
    System.out.flush();
    if (args[3].equals("capacity")) OwnerCapacityProof.main(args);
    else OwnerTLSProof.main(args);
  }
}
