package org.nostrocket.hypergolic.host;

import android.os.Build;
import android.os.Process;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Disposable shell-UID proof of the owning plan/ACK classes with boot-framework JSON. */
public final class DevicePlanProof {
  private DevicePlanProof() {}
  public static void main(String[] args) throws Exception {
    if (Build.VERSION.SDK_INT != 36 || Process.myUid() != 2000) throw new AssertionError("Unexpected runtime scope");
    ClassLoader boot = String.class.getClassLoader();
    if (JSONObject.class.getClassLoader() != boot || JSONArray.class.getClassLoader() != boot || JSONTokener.class.getClassLoader() != boot) throw new AssertionError("JSON is not supplied by boot framework");
    System.out.println(new JSONObject().put("phase", "runtime").put("sdk", Build.VERSION.SDK_INT).put("uid", Process.myUid())
      .put("pid", Process.myPid()).put("model", Build.MODEL).put("frameworkJson", true).put("jsonLoader", String.valueOf(boot)));
    if (args.length == 2 && args[1].equals("--ack-grammar")) PlanProof.acknowledgementGrammarProof();
    else PlanProof.main(args);
  }
}
