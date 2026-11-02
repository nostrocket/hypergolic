package org.nostrocket.hypergolic.signercore;

import android.os.SystemClock;
import java.io.IOException;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;

/** Drives the unchanged production operation through independent, deterministic guard callbacks. */
public final class RemoteOperationTests {
  private static int assertions, cases;
  private static final List<String> failures = new ArrayList<>();
  private interface Action { void run() throws Exception; }
  private static void check(boolean value, String message) {
    assertions++;
    if (!value) throw new AssertionError(message);
  }
  private static void test(String name, Action body) {
    cases++;
    SystemClock.now = 100;
    try { body.run(); }
    catch (Exception | AssertionError failure) { failures.add(name + ": " + failure.getMessage()); }
  }
  private static RuntimeException denied(Action body, String expected) throws Exception {
    try { body.run(); }
    catch (RuntimeException failure) {
      check(expected.equals(failure.getMessage()), "expected " + expected + ", got " + failure.getMessage());
      return failure;
    }
    throw new AssertionError("denied operation returned successfully");
  }
  private static final class Guard implements NativeRemoteOperation.Guard {
    int checks, executions, signingAuthorizations;
    Runnable onCheck = () -> {};
    Runnable onExecute = () -> {};
    Runnable onSigningSend = () -> {};
    public void check() { checks++; onCheck.run(); }
    public void execute() { executions++; onExecute.run(); }
    public void beforeSigningSend() { signingAuthorizations++; onSigningSend.run(); }
  }
  private static final class RelayBoundary {
    int permittedWrites;
    void write(NativeRemoteOperation operation) throws IOException {
      operation.beforeSend();
      permittedWrites++; // Observation after the production write-admission callback; no actual I/O.
    }
  }
  private static final class TrackedSocket extends Socket {
    int closes;
    @Override public void close() { closes++; }
  }
  private static NativeRemoteOperation operation(Guard guard) { return new NativeRemoteOperation(1000, guard); }
  private static void signingSend(NativeRemoteOperation operation, Guard guard, RelayBoundary relay) throws Exception {
    operation.signingFrame(); relay.write(operation);
    check(operation.uncertain(), "possible signing write must be remembered");
    check(guard.signingAuthorizations == 1 && relay.permittedWrites == 1, "one admitted signing write");
  }

  public static void main(String[] args) {
    test("constructor guards", () -> {
      denied(() -> new NativeRemoteOperation(100, new Guard()), "SIGNER_EXPIRED");
      denied(() -> new NativeRemoteOperation(1000, null), "SIGNER_EXPIRED");
    });
    test("independent final execute gate", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g);
      o.execute();
      check(g.checks == 1 && g.executions == 1, "both guards run exactly once");
      check(!o.uncertain() && g.signingAuthorizations == 0, "execute is not a send");
    });
    test("pre-send final denial preserved", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); RelayBoundary relay = new RelayBoundary();
      NativeVault.Error refusal = new NativeVault.Error("AUTHORIZATION_DENIED");
      g.onExecute = () -> { throw refusal; };
      check(denied(() -> relay.write(o), "AUTHORIZATION_DENIED") == refusal, "original denial preserved");
      check(g.checks == 1 && g.executions == 1, "check passed before final refusal");
      check(!o.uncertain() && relay.permittedWrites == 0 && g.signingAuthorizations == 0, "no signing dispatch");
    });
    test("post-send final denial is uncertain", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); RelayBoundary relay = new RelayBoundary();
      signingSend(o, g, relay);
      int checked = g.checks, executed = g.executions;
      g.onExecute = () -> { throw new NativeVault.Error("AUTHORIZATION_DENIED"); };
      denied(o::execute, "SIGNER_UNCERTAIN");
      check(g.checks == checked + 1 && g.executions == executed + 1, "final guard enforced after passing check");
      check(relay.permittedWrites == 1 && g.signingAuthorizations == 1, "no repeated write/authorization");
    });
    test("post-send arbitrary runtime refusal is uncertain", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); RelayBoundary relay = new RelayBoundary();
      signingSend(o, g, relay);
      g.onExecute = () -> { throw new IllegalStateException("public-test-refusal"); };
      denied(() -> relay.write(o), "SIGNER_UNCERTAIN");
      check(relay.permittedWrites == 1 && g.signingAuthorizations == 1, "failed re-admission creates no write");
    });
    test("pre-send check denial short circuits final gate", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g);
      NativeVault.Error refusal = new NativeVault.Error("AUTHORIZATION_DENIED");
      g.onCheck = () -> { throw refusal; };
      check(denied(o::execute, "AUTHORIZATION_DENIED") == refusal, "check denial preserved");
      check(g.checks == 1 && g.executions == 0 && !o.uncertain(), "final gate not reached");
    });
    test("post-send check denial remains uncertain", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); RelayBoundary relay = new RelayBoundary();
      signingSend(o, g, relay); int executions = g.executions;
      g.onCheck = () -> { throw new NativeVault.Error("AUTHORIZATION_DENIED"); };
      denied(o::execute, "SIGNER_UNCERTAIN");
      check(g.executions == executions && relay.permittedWrites == 1, "check denies before execute and any write");
    });
    test("deadline before send", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); SystemClock.now = 1000;
      denied(o::execute, "SIGNER_EXPIRED");
      check(g.checks == 0 && g.executions == 0 && !o.uncertain(), "exact deadline rejects without callbacks");
      check(o.isCancelled(), "expired operation reports cancelled");
    });
    test("deadline after send", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); RelayBoundary relay = new RelayBoundary();
      signingSend(o, g, relay); SystemClock.now = 1000;
      denied(o::execute, "SIGNER_UNCERTAIN");
      check(o.isCancelled() && relay.permittedWrites == 1, "expiry cannot repeat a send");
    });
    test("close before send", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); TrackedSocket socket = new TrackedSocket();
      o.attach(socket); o.close(); o.close();
      check(socket.closes == 1, "owned socket closed once");
      denied(o::execute, "AUTHORIZATION_DENIED");
      check(o.isCancelled() && !o.uncertain() && g.executions == 0, "closed pre-send operation denied");
      TrackedSocket late = new TrackedSocket();
      try { o.attach(late); throw new AssertionError("closed operation accepted late socket"); }
      catch (IOException expected) { check(late.closes == 1, "late socket closed"); }
    });
    test("close after send", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); RelayBoundary relay = new RelayBoundary();
      signingSend(o, g, relay); TrackedSocket socket = new TrackedSocket(); o.attach(socket); o.close();
      denied(o::execute, "SIGNER_UNCERTAIN");
      check(o.isCancelled() && socket.closes == 1 && relay.permittedWrites == 1, "close preserves uncertainty without another write");
    });
    test("non-signing send does not set signing uncertainty", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); RelayBoundary relay = new RelayBoundary();
      relay.write(o);
      check(!o.uncertain() && g.signingAuthorizations == 0 && relay.permittedWrites == 1, "ordinary relay frame is not signing dispatch");
      o.close(); denied(o::execute, "AUTHORIZATION_DENIED");
    });
    test("signing marker requires final authorization", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); RelayBoundary relay = new RelayBoundary();
      g.onExecute = () -> { throw new NativeVault.Error("AUTHORIZATION_DENIED"); };
      denied(o::signingFrame, "AUTHORIZATION_DENIED");
      g.onExecute = () -> {}; relay.write(o);
      check(!o.uncertain() && g.signingAuthorizations == 0, "denied marker never arms signing");
    });
    test("first signing-send callback refusal stays certain", () -> {
      Guard g = new Guard(); NativeRemoteOperation o = operation(g); RelayBoundary relay = new RelayBoundary(); o.signingFrame();
      g.onSigningSend = () -> { throw new NativeVault.Error("AUTHORIZATION_DENIED"); };
      denied(() -> relay.write(o), "AUTHORIZATION_DENIED");
      check(!o.uncertain() && relay.permittedWrites == 0, "first callback refusal permits no signing write");
    });
    check(cases == 14, "all cases selected");
    StringBuilder rows = new StringBuilder();
    for (String failure : failures) {
      if (rows.length() > 0) rows.append(',');
      rows.append('"').append(failure.replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
    }
    System.out.println("{\"passed\":" + failures.isEmpty() + ",\"cases\":" + cases + ",\"assertions\":" + assertions + ",\"failures\":[" + rows + "]}");
    if (!failures.isEmpty()) System.exit(1);
  }
}
