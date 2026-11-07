package org.nostrocket.hypergolic.signercore;

import java.util.HashSet;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;

/** Native session accounting, not consent. The host permit must independently guard each emission. */
final class NativeCvmLifetime implements AutoCloseable {
  private static final Object LOCK = new Object();
  private static final Set<Session> SESSIONS = new HashSet<>();
  private final LongSupplier clock;
  private boolean foreground, closed, clockFailed;
  private long revision, lastTime = -1;
  static final class Session {
    private final NativeCvmLifetime owner;
    private final long revision;
    private final BooleanSupplier current;
    private long idleDeadline;
    private boolean cancelled, released, uncertain;
    private Operation operation;
    private Session(NativeCvmLifetime owner, BooleanSupplier current, long idleDeadline) {
      this.owner = owner; this.current = current; this.revision = owner.revision; this.idleDeadline = idleDeadline;
    }
  }
  static final class Operation {
    private final Session session;
    private final long deadline;
    private boolean terminal;
    private Operation(Session session, long deadline) { this.session = session; this.deadline = deadline; }
  }
  NativeCvmLifetime(LongSupplier clock) { this.clock = clock; }
  private static IllegalStateException denied() { return new IllegalStateException("CVM session unavailable"); }
  private long now() {
    long value;
    try { value = clock.getAsLong(); } catch (RuntimeException failure) { value = -1; }
    if (value < lastTime || value < 0 || value > Long.MAX_VALUE - 120_000) clockFailed = true;
    if (clockFailed) throw denied();
    lastTime = value; return value;
  }
  private void check(Session session, long time) {
    if (closed || !foreground || session == null || session.owner != this || session.revision != revision ||
        session.cancelled || session.released || session.uncertain || !SESSIONS.contains(session) ||
        (session.operation == null && time >= session.idleDeadline)) throw denied();
  }
  /** The caller supplies native scope liveness, never a guest predicate or a JavaScript clock. */
  Session open(BooleanSupplier current) {
    if (current == null || !current.getAsBoolean()) throw denied();
    synchronized (LOCK) {
      long time = now();
      if (closed || !foreground || SESSIONS.size() >= 2 || time > Long.MAX_VALUE - 120_000) throw denied();
      Session session = new Session(this, current, time + 30_000);
      SESSIONS.add(session); return session;
    }
  }
  /** Deadline comes from the owning native first-ingress capture and includes review/init/dispatch. */
  Operation begin(Session session, long originalDeadline) {
    current(session);
    synchronized (LOCK) {
      long time = now(); check(session, time);
      if (session.operation != null || originalDeadline <= time || originalDeadline - time > 120_000) throw denied();
      Operation operation = new Operation(session, originalDeadline);
      session.operation = operation; return operation;
    }
  }
  void current(Session session) {
    if (session == null || session.owner != this || !session.current.getAsBoolean()) throw denied();
    synchronized (LOCK) { check(session, now()); }
  }
  void current(Operation operation) {
    if (operation == null) throw denied();
    current(operation.session);
    synchronized (LOCK) {
      long time = now(); check(operation.session, time);
      if (operation.terminal || operation.session.operation != operation || time >= operation.deadline) throw denied();
    }
  }
  /** Final delivery remains bound to this operation until the consumer has captured its result. */
  void delivered(Operation operation) {
    current(operation);
    synchronized (LOCK) {
      long time = now(); check(operation.session, time);
      if (operation.terminal || operation.session.operation != operation || time >= operation.deadline) throw denied();
      operation.terminal = true; operation.session.operation = null;
      operation.session.idleDeadline = now() + 30_000;
    }
  }
  void cancel(Session session) {
    synchronized (LOCK) { if (session != null && session.owner == this) session.cancelled = true; }
  }
  /** Only the actual transport/key teardown calls this, once every owned resource has unwound. */
  void drained(Session session, boolean certain) {
    synchronized (LOCK) {
      if (session == null || session.owner != this || session.released) return;
      session.cancelled = true;
      if (!certain) { session.uncertain = true; return; }
      // A previous uncertain release is sticky; retries cannot attest that lost resources were drained.
      if (session.uncertain) return;
      session.released = true; SESSIONS.remove(session);
    }
  }
  void foreground(boolean value) {
    synchronized (LOCK) {
      foreground = value;
      if (!value) {
        revision++;
        for (Session session : SESSIONS) if (session.owner == this) session.cancelled = true;
      }
    }
  }
  @Override public void close() {
    synchronized (LOCK) { closed = true; foreground(false); }
  }
}
