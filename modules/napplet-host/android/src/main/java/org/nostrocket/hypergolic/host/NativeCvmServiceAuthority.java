package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

/** CVM-only foreground service consent. It deliberately does not alter any other capability's focus gate. */
public final class NativeCvmServiceAuthority {
  public static final long MAXIMUM_MILLIS = 120_000;
  public static final String CONSENT = "This request can keep running while you use another napplet. It stops when this app goes into the background, the account changes, or you close this napplet. Up to 2 minutes. Payments through Hypergolic are unavailable. Provider tools may have external effects.";
  /** Only the native profile-gated ingress constructs registrations, never a guest or an Expo argument. */
  public static final class Source {
    public final String endpoint, generation, user, publisher, appId, version, instance;
    public final long epoch;
    Source(String endpoint, String generation, String user, long epoch, String publisher, String appId, String version, String instance) {
      if (!handle(endpoint) || !handle(generation) || !handle(instance) || !hex(user) || !hex(publisher) || !hex(version) ||
          epoch < 0 || epoch > 9_007_199_254_740_991L || !text(appId, 1024)) throw new IllegalArgumentException("Invalid CVM source");
      this.endpoint = endpoint; this.generation = generation; this.user = user; this.epoch = epoch;
      this.publisher = publisher; this.appId = appId; this.version = version; this.instance = instance;
    }
  }
  public static final class Registration {
    private final Source source;
    private Registration(Source source) { this.source = source; }
  }
  public static final class Request { private Request() {} }
  public static final class Review {
    public final Request request;
    public final Source source;
    public final String provider, operation, message;
    public final List<String> relays;
    public final long originalDeadline;
    public final boolean continuesWhileUnfocused = true;
    private Review(Request request, Row row) {
      this.request = request; source = row.registration.source; provider = row.provider;
      operation = row.operation; message = row.message; relays = row.relays; originalDeadline = row.deadline;
    }
  }
  public static final class Permit {
    private final NativeCvmServiceAuthority owner;
    private final Row row;
    private final long revision;
    private boolean emitted, cancelled;
    private Permit(NativeCvmServiceAuthority owner, Row row, long revision) { this.owner = owner; this.row = row; this.revision = revision; }
    public Source source() { return row.registration.source; }
    public String provider() { return row.provider; }
    public List<String> relays() { return row.relays; }
    public long originalDeadline() { return row.deadline; }
    public boolean current() { return owner.current(this); }
    public boolean sourceCurrent() { return owner.current(row.registration); }
    public boolean sameSource(Permit other) { return other != null && owner == other.owner && row.registration == other.row.registration; }
  }
  private static final class Row {
    final Registration registration;
    final String provider, operation, message;
    final List<String> relays;
    final long deadline;
    Row(Registration registration, String provider, String operation, String message, List<String> relays, long deadline) {
      this.registration = registration; this.provider = provider; this.operation = operation;
      this.message = message; this.relays = java.util.Collections.unmodifiableList(new java.util.ArrayList<>(relays)); this.deadline = deadline;
    }
  }
  private final LongSupplier clock;
  private final Map<String, Registration> registrations = new LinkedHashMap<>();
  private final Map<Request, Row> waiting = new LinkedHashMap<>();
  private final Map<Permit, Row> active = new LinkedHashMap<>();
  private String user;
  private long epoch = -1, revision, lastTime = -1;
  private boolean foreground, closed, clockFailed;
  public NativeCvmServiceAuthority(LongSupplier clock) { this.clock = clock; }
  private static boolean hex(String value) { return value != null && value.matches("[0-9a-f]{64}"); }
  private static boolean handle(String value) { return value != null && value.matches("[A-Za-z0-9_-]{1,80}"); }
  private static boolean text(String value, int maximum) {
    if (value == null || value.isEmpty() || value.length() > maximum || value.getBytes(StandardCharsets.UTF_8).length > maximum) return false;
    for (int index = 0; index < value.length(); index++) if (value.charAt(index) < 32 || value.charAt(index) == 127) return false;
    return true;
  }
  private long time() {
    long now;
    try { now = clock.getAsLong(); } catch (RuntimeException failure) { now = -1; }
    if (now < 0 || now < lastTime || now > Long.MAX_VALUE - MAXIMUM_MILLIS) clockFailed = true;
    if (!clockFailed) lastTime = now;
    return lastTime;
  }
  private boolean live(Registration registration) {
    Source source = registration.source;
    return !closed && !clockFailed && foreground && registrations.get(source.generation) == registration &&
      source.user.equals(user) && source.epoch == epoch;
  }
  private void prune() {
    long now = time();
    waiting.entrySet().removeIf(entry -> !live(entry.getValue().registration) || now >= entry.getValue().deadline);
    active.entrySet().removeIf(entry -> {
      Permit permit = entry.getKey(); Row row = entry.getValue();
      if (!live(row.registration) || permit.revision != revision || now >= row.deadline) { permit.cancelled = true; return true; }
      return false;
    });
  }
  /** Native composition sets the actual account binding; registration never silently selects an account. */
  public synchronized void account(String selectedUser, long selectedEpoch) {
    if (!hex(selectedUser) || selectedEpoch < 0 || selectedEpoch > 9_007_199_254_740_991L) { close(); return; }
    if (!selectedUser.equals(user) || selectedEpoch != epoch) { revision++; waiting.clear(); for (Permit permit : active.keySet()) permit.cancelled = true; active.clear(); registrations.clear(); }
    user = selectedUser; epoch = selectedEpoch; prune();
  }
  public synchronized Registration register(Source source) {
    prune();
    if (source == null || closed || clockFailed || registrations.size() >= 64 || registrations.containsKey(source.generation)) return null;
    Registration registration = new Registration(source); registrations.put(source.generation, registration); return registration;
  }
  /** Invoke on first native ingress, before React Native delivery, review, setup, or any remote effects. */
  public synchronized Request admit(Registration registration, String provider, String operation, String exactMessage, List<String> relays, long timeoutMillis) {
    prune();
    if (registration == null || !live(registration) || !hex(provider) || !text(operation, 128) || exactMessage == null ||
        exactMessage.isEmpty() || exactMessage.length() > 32768 || exactMessage.getBytes(StandardCharsets.UTF_8).length > 32768 ||
        timeoutMillis < 1 || timeoutMillis > MAXIMUM_MILLIS || relays == null || relays.isEmpty() || relays.size() > 4 ||
        relays.stream().anyMatch(relay -> !text(relay, 2048)) || relays.stream().distinct().count() != relays.size() || waiting.size() + active.size() >= 4) return null;
    long own = waiting.values().stream().filter(row -> row.registration == registration).count() + active.values().stream().filter(row -> row.registration == registration).count();
    if (own >= 2) return null;
    Request request = new Request(); waiting.put(request, new Row(registration, provider, operation, exactMessage, relays, lastTime + timeoutMillis)); return request;
  }
  public synchronized Review review() {
    prune();
    for (Map.Entry<Request, Row> entry : waiting.entrySet()) return new Review(entry.getKey(), entry.getValue());
    return null;
  }
  /** Only this exact native review decision mints a one-use service permit. Focus is intentionally not its lifetime. */
  public synchronized Permit approve(Request request) {
    Review review = review(); if (review == null || review.request != request) return null;
    Row row = waiting.remove(request); Permit permit = new Permit(this, row, revision); active.put(permit, row); return permit;
  }
  public synchronized boolean current(Registration registration) { prune(); return registration != null && live(registration); }
  public synchronized boolean current(Permit permit) {
    if (permit == null || permit.owner != this) return false;
    prune(); return !permit.cancelled && permit.revision == revision && active.get(permit) == permit.row && live(permit.row.registration);
  }
  public synchronized boolean consume(Permit permit, String provider, String exactMessage, String relay) {
    if (!current(permit) || permit.emitted || !permit.row.provider.equals(provider) || !permit.row.message.equals(exactMessage) || !permit.row.relays.contains(relay)) return false;
    permit.emitted = true; return true;
  }
  public synchronized boolean finish(Permit permit) { boolean valid = current(permit); cancel(permit); return valid; }
  public synchronized void cancel(Request request) { waiting.remove(request); }
  public synchronized void cancel(Permit permit) { if (permit != null && permit.owner == this) { permit.cancelled = true; active.remove(permit); } }
  public synchronized void revoke(Registration registration) {
    if (registration != null && registrations.get(registration.source.generation) == registration) registrations.remove(registration.source.generation);
    prune();
  }
  public synchronized void foreground(boolean value) {
    foreground = value;
    if (!value) { revision++; waiting.clear(); for (Permit permit : active.keySet()) permit.cancelled = true; active.clear(); registrations.clear(); }
    prune();
  }
  public synchronized void close() { closed = true; foreground(false); registrations.clear(); }
}
