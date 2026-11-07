package org.nostrocket.hypergolic.host;

import android.os.SystemClock;
import java.io.IOException;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.function.LongSupplier;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLSocketFactory;

/** App-only NIP-46 WSS connection. Send/read use one serial worker; close may cancel it. */
public final class NativeSignerRelay implements AutoCloseable {
  public static final int MAX_BYTES = 8 * 1024 * 1024;
  public interface Control extends PublishedHttpsTransport.Cancellation {
    void attach(Socket raw) throws IOException;
    /** Validate authority and mark possible dispatch, then return before network I/O. */
    void beforeSend() throws IOException;
    default boolean tracksResolution() { return false; }
    default void resolutionReserved() {}
    default void resolutionDrained() {}
  }
  /** One operation shares this budget and its original deadline across at most three opens. */
  public static final class Budget {
    private static final int MAX_WIRE = 32 * 1024 * 1024;
    private static final int MAX_FRAMES = 64, MAX_TEXTS = 32, MAX_RELAYS = 3;
    private final int maxRelays;
    private final int maxWire, maxFrames, maxTexts, maxTextBytes;
    public Budget() { this(MAX_RELAYS); }
    private Budget(int maxRelays) { this(maxRelays, MAX_WIRE, MAX_FRAMES, MAX_TEXTS, MAX_BYTES); }
    private Budget(int maxRelays, int maxWire, int maxFrames, int maxTexts, int maxTextBytes) {
      this.maxRelays = maxRelays; this.maxWire = maxWire; this.maxFrames = maxFrames;
      this.maxTexts = maxTexts; this.maxTextBytes = maxTextBytes;
    }
    /** New native-only CVM profile; existing signer/refresh constructors keep their exact limits. */
    public static Budget forCvm() { return new Budget(4, 4 * 1024 * 1024, 4096, 2048, 66 * 1024); }
    /** Native Settings refresh checks the old and proposed lists under one unchanged aggregate budget. */
    public static Budget forRefresh() { return new Budget(6); }
    private int wireBytes, frames, texts, relays;
    private long deadline;
    private boolean failed;
    synchronized void admit(long originalDeadline) throws IOException {
      check();
      if (originalDeadline <= 0 || relays >= maxRelays || relays != 0 && deadline != originalDeadline) throw fail();
      deadline = originalDeadline; relays++;
    }
    synchronized int reserveRead(int wanted) throws IOException {
      check();
      if (wanted <= 0 || wireBytes == maxWire) throw fail();
      int reserved = Math.min(wanted, maxWire - wireBytes);
      wireBytes += reserved;
      return reserved;
    }
    synchronized void finishRead(int reserved, int received) {
      if (reserved < 0 || received < 0 || received > reserved) { failed = true; return; }
      wireBytes -= reserved - received;
    }
    synchronized void wire(int bytes) throws IOException {
      check();
      if (bytes < 0 || bytes > maxWire - wireBytes) throw fail();
      wireBytes += bytes;
    }
    synchronized void outbound(int bytes, boolean text) throws IOException {
      check();
      if (bytes < 0 || bytes > maxWire - wireBytes || frames == maxFrames || text && texts == maxTexts) throw fail();
      wireBytes += bytes; frames++; if (text) texts++;
    }
    synchronized void inbound(long frameCount, int textCount) throws IOException {
      check();
      if (frameCount < 0 || frameCount > maxFrames - frames || textCount < 0 || textCount > maxTexts - texts) throw fail();
      frames += (int) frameCount; texts += textCount;
    }
    private synchronized void check() throws IOException { if (failed) throw new IOException("Native relay budget exhausted"); }
    private IOException fail() { failed = true; return new IOException("Native relay exceeded operation bounds"); }
  }
  /** Immutable package-local fixture inputs; no production setter or Expo route exists. */
  static final class Transport extends NativeSignerRelayOpening.RelayTransport {
    final LongSupplier clock;
    Transport(PublishedHttpsTransport.AddressPolicy policy, PublishedHttpsTransport.HostResolver resolver,
        ThreadPoolExecutor executor, SSLSocketFactory factory, HostnameVerifier verifier, LongSupplier clock) {
      super(policy, resolver, executor, factory, verifier);
      if (clock == null) throw new IllegalArgumentException("Missing relay clock");
      this.clock = clock;
    }
  }

  private final NativeSignerRelayOpening.OpenRelay connection;
  private final Control control;
  private final Budget budget;
  private final PublishedRelayWebSocketFrames frames;
  private final ArrayDeque<String> pending = new ArrayDeque<>();
  private volatile boolean closed;
  private boolean remoteClosed;
  private long seenFrames;
  private NativeSignerRelay(NativeSignerRelayOpening.OpenRelay connection, Control control, Budget budget) {
    this.connection = connection; this.control = control; this.budget = budget;
    this.frames = new PublishedRelayWebSocketFrames(budget.maxTextBytes);
  }
  public static String canonical(String rawUrl) throws IOException {
    PublishedRelayWssQuery.parseUrl(rawUrl);
    return rawUrl;
  }
  public static NativeSignerRelay open(String rawUrl, Control control, long deadlineElapsedMs, Budget budget) throws IOException {
    prepare(rawUrl, control, deadlineElapsedMs, budget);
    PublishedRelayWssQuery.Deadline deadline = PublishedRelayWssQuery.Deadline.atElapsed(deadlineElapsedMs, SystemClock::elapsedRealtime);
    NativeSignerRelayOpening.OpenRelay connection = NativeSignerRelayOpening.openRelay(rawUrl, opening(control, budget), deadline);
    return new NativeSignerRelay(connection, control, budget);
  }
  static NativeSignerRelay openWithTransport(String rawUrl, Control control, long deadlineElapsedMs,
      Budget budget, Transport transport) throws IOException {
    prepare(rawUrl, control, deadlineElapsedMs, budget);
    PublishedRelayWssQuery.Deadline deadline = PublishedRelayWssQuery.Deadline.atElapsed(deadlineElapsedMs, transport.clock);
    NativeSignerRelayOpening.OpenRelay connection = NativeSignerRelayOpening.openRelay(rawUrl, opening(control, budget), deadline, transport);
    return new NativeSignerRelay(connection, control, budget);
  }
  private static void prepare(String url, Control control, long deadline, Budget budget) throws IOException {
    canonical(url);
    if (control == null || budget == null) throw new IOException("Missing native relay authority");
    budget.admit(deadline);
  }
  private static NativeSignerRelayOpening.OpenControl opening(Control control, Budget budget) {
    return new NativeSignerRelayOpening.OpenControl() {
      @Override public boolean isCancelled() { return control.isCancelled(); }
      @Override public void attach(Socket raw) throws IOException { control.attach(raw); }
      @Override public int reserveRead(int wanted) throws IOException { return budget.reserveRead(wanted); }
      @Override public void finishRead(int reserved, int received) { budget.finishRead(reserved, received); }
      @Override public void beforeWrite(int bytes) throws IOException { budget.wire(bytes); }
      @Override public boolean tracksResolution() { return control.tracksResolution(); }
      @Override public void resolutionReserved() { control.resolutionReserved(); }
      @Override public void resolutionDrained() { control.resolutionDrained(); }
    };
  }
  public void send(String text) throws IOException {
    check();
    final byte[] frame;
    try { frame = PublishedRelayWebSocketClientFrames.textReq(text, budget.maxTextBytes); }
    catch (IllegalArgumentException invalid) { throw new IOException("Invalid native relay text", invalid); }
    try {
      if (remoteClosed) throw new IOException("Native relay is closed");
      budget.outbound(frame.length, true);
      control.beforeSend(); // No owner/session lock is held by this transport during the write.
      check();
      connection.output.write(frame); connection.output.flush();
    } catch (IOException failure) { close(); throw failure; }
    catch (RuntimeException unavailable) { close(); throw new IOException("Native relay send authority unavailable", unavailable); }
  }
  public String read() throws IOException {
    for (;;) { String text = poll(); if (text != null) return text; }
  }
  /** One serial owner's bounded read turn, so it can check a pending authenticated side publication. */
  public String poll() throws IOException { return poll(PublishedRelayWssQuery.READ_TIMEOUT_MS); }
  /** Short CVM actor turn; original signer polling and every absolute deadline remain unchanged. */
  public String pollCvm() throws IOException { return poll(100); }
  private String poll(int maximumIdle) throws IOException {
    try {
      while (pending.isEmpty()) {
        check();
        if (remoteClosed) throw new IOException("Native relay is closed");
        byte[] buffer = new byte[PublishedRelayWebSocketFrames.MAX_READ];
        final int count;
        try { count = connection.input.readWithTimeout(buffer, 0, buffer.length, maximumIdle); }
        catch (SocketTimeoutException idle) { check(); return null; }
        if (count < 0) throw new IOException("Native relay ended before response");
        if (count == 0) continue;
        preflight(Arrays.copyOf(buffer, count));
      }
      check();
      return pending.removeFirst();
    } catch (IOException failure) { close(); throw failure; }
    catch (RuntimeException unavailable) { close(); throw new IOException("Native relay state unavailable", unavailable); }
  }
  private void preflight(byte[] bytes) throws IOException {
    List<PublishedRelayWebSocketFrames.Event> batch = frames.feed(bytes);
    long completed = frames.completedFrameCount();
    int texts = 0;
    for (PublishedRelayWebSocketFrames.Event event : batch) {
      if ("error".equals(event.type)) throw new IOException("Invalid native relay frame");
      if ("text".equals(event.type)) texts++;
    }
    if (frames.consumedInputBytes() != bytes.length) throw new IOException("Trailing native relay frame bytes");
    budget.inbound(completed - seenFrames, texts); seenFrames = completed;
    for (PublishedRelayWebSocketFrames.Event event : batch) {
      check();
      if ("text".equals(event.type)) pending.addLast(event.text);
      else if ("ping".equals(event.type)) {
        byte[] pong = PublishedRelayWebSocketClientFrames.pong(event.bytes);
        budget.outbound(pong.length, false);
        check(); connection.output.write(pong); connection.output.flush();
      } else if ("close".equals(event.type)) remoteClosed = true;
    }
  }
  private void check() throws IOException {
    if (closed) throw new IOException("Native relay is closed");
    budget.check();
    try { connection.abort.check(); }
    catch (RuntimeException unavailable) { close(); throw new IOException("Native relay authority unavailable", unavailable); }
  }
  public boolean closeKnown() { closed = true; return connection.closeKnown(); }
  @Override public void close() { closeKnown(); }
}
