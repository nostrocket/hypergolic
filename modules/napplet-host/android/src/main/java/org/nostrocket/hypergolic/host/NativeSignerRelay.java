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
  }
  /** One operation shares this budget and its original deadline across at most three opens. */
  public static final class Budget {
    private static final int MAX_WIRE = 32 * 1024 * 1024;
    private static final int MAX_FRAMES = 64, MAX_TEXTS = 32, MAX_RELAYS = 3;
    private final int maxRelays;
    public Budget() { this(MAX_RELAYS); }
    private Budget(int maxRelays) { this.maxRelays = maxRelays; }
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
      if (wanted <= 0 || wireBytes == MAX_WIRE) throw fail();
      int reserved = Math.min(wanted, MAX_WIRE - wireBytes);
      wireBytes += reserved;
      return reserved;
    }
    synchronized void finishRead(int reserved, int received) {
      if (reserved < 0 || received < 0 || received > reserved) { failed = true; return; }
      wireBytes -= reserved - received;
    }
    synchronized void wire(int bytes) throws IOException {
      check();
      if (bytes < 0 || bytes > MAX_WIRE - wireBytes) throw fail();
      wireBytes += bytes;
    }
    synchronized void outbound(int bytes, boolean text) throws IOException {
      check();
      if (bytes < 0 || bytes > MAX_WIRE - wireBytes || frames == MAX_FRAMES || text && texts == MAX_TEXTS) throw fail();
      wireBytes += bytes; frames++; if (text) texts++;
    }
    synchronized void inbound(long frameCount, int textCount) throws IOException {
      check();
      if (frameCount < 0 || frameCount > MAX_FRAMES - frames || textCount < 0 || textCount > MAX_TEXTS - texts) throw fail();
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
  private final PublishedRelayWebSocketFrames frames = new PublishedRelayWebSocketFrames(MAX_BYTES);
  private final ArrayDeque<String> pending = new ArrayDeque<>();
  private volatile boolean closed;
  private boolean remoteClosed;
  private long seenFrames;
  private NativeSignerRelay(NativeSignerRelayOpening.OpenRelay connection, Control control, Budget budget) {
    this.connection = connection; this.control = control; this.budget = budget;
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
    };
  }
  public void send(String text) throws IOException {
    check();
    final byte[] frame;
    try { frame = PublishedRelayWebSocketClientFrames.textReq(text, MAX_BYTES); }
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
    try {
      while (pending.isEmpty()) {
        check();
        if (remoteClosed) throw new IOException("Native relay is closed");
        byte[] buffer = new byte[PublishedRelayWebSocketFrames.MAX_READ];
        final int count;
        try { count = connection.input.read(buffer); }
        catch (SocketTimeoutException idle) { check(); continue; }
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
  @Override public void close() { closed = true; connection.close(); }
}
