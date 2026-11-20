package org.nostrocket.hypergolic.host;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.net.Socket;
import java.net.SocketTimeoutException;
import javax.net.ssl.SSLSocket;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.Deadline;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.StreamControl;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.TextKind;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.RelayUrl;
import static org.nostrocket.hypergolic.host.PublishedRelayWssQuery.READ_TIMEOUT_MS;
import static org.nostrocket.hypergolic.host.PublishedRelayWssQuery.readHandshake;
import static org.nostrocket.hypergolic.host.PublishedRelayWssQuery.sendHandshake;
/** Existing socket I/O helpers shared by query and stream operations. */
final class PublishedRelayWssIo {
  static void readStream(SSLSocket tls, RelayUrl relay, byte[] nonce, byte[] requestFrame, String subscriptionId,
      StreamControl control, Deadline deadline, AbortMonitor abort) throws IOException {
    DeadlineInput input = new DeadlineInput(tls.getInputStream(), tls, deadline);
    OutputStream output = tls.getOutputStream();
    sendHandshake(output, relay, nonce);
    PublishedRelayWebSocketHandshake.validate(readHandshake(input, abort), nonce);
    output.write(requestFrame); output.flush();
    PublishedRelayWebSocketFrames frames = new PublishedRelayWebSocketFrames();
    PublishedRelayResponseClassifier classifier = new PublishedRelayResponseClassifier(subscriptionId);
    byte[] buffer = new byte[PublishedRelayWebSocketFrames.MAX_READ];
    long window = System.nanoTime(), lastRead = window;
    boolean awaitingPong = false;
    int frameCount = 0, wireBytes = 0;
    while (true) {
      abort.check();
      int count;
      try { count = input.read(buffer); }
      catch (SocketTimeoutException idle) {
        if (!deadline.persistent || deadline.expired()) throw idle;
        if (!awaitingPong && System.nanoTime() - lastRead >= TimeUnit.SECONDS.toNanos(45)) {
          deadline.awaitPong();
          awaitingPong = true;
          output.write(PublishedRelayWebSocketClientFrames.ping()); output.flush();
        }
        continue;
      }
      if (count < 0) throw new IOException("Relay stream closed");
      long current = System.nanoTime(); lastRead = current;
      if (current - window >= 1_000_000_000L) { window = current; frameCount = 0; wireBytes = 0; }
      wireBytes += count;
      if (wireBytes > 2 * 1024 * 1024) throw new IOException("Relay stream byte rate exceeded");
      byte[] chunk = java.util.Arrays.copyOf(buffer, count);
      List<PublishedRelayWebSocketFrames.Event> batch = frames.feed(chunk);
      if (batch.size() > 64 - frameCount) throw new IOException("Relay stream frame rate exceeded");
      frameCount += batch.size();
      // Validate the full decoded read before any application delivery.
      for (PublishedRelayWebSocketFrames.Event event : batch) {
        if ("error".equals(event.type) || "close".equals(event.type)) throw new IOException("Invalid or closed relay stream");
        if ("text".equals(event.type)) classifier.classify(event.text);
      }
      for (PublishedRelayWebSocketFrames.Event event : batch) {
        abort.check();
        if ("text".equals(event.type)) {
          if (!deadline.persistent && classifier.classify(event.text) == TextKind.EOSE) deadline.persistent();
          control.text(event.text);
        } else if (awaitingPong && "pong".equals(event.type) && event.bytes.length == 0) {
          awaitingPong = false; deadline.persistent();
        } else if ("ping".equals(event.type)) { output.write(PublishedRelayWebSocketClientFrames.pong(event.bytes)); output.flush(); }
      }
    }
  }

  static final class DeadlineInput extends InputStream {
    final InputStream delegate;
    final Socket socket;
    final Deadline deadline;
    DeadlineInput(InputStream delegate, Socket socket, Deadline deadline) {
      this.delegate = delegate; this.socket = socket; this.deadline = deadline;
    }
    @Override public int read() throws IOException {
      socket.setSoTimeout(deadline.timeoutMs(READ_TIMEOUT_MS));
      return delegate.read();
    }
    @Override public int read(byte[] target, int offset, int length) throws IOException {
      return readWithTimeout(target, offset, length, READ_TIMEOUT_MS);
    }
    int readWithTimeout(byte[] target, int offset, int length, int maximumIdle) throws IOException {
      if (maximumIdle < 1 || maximumIdle > READ_TIMEOUT_MS) throw new IOException("Invalid relay read turn");
      socket.setSoTimeout(deadline.timeoutMs(maximumIdle));
      return delegate.read(target, offset, length);
    }
  }

  static final class AbortMonitor implements AutoCloseable {
    final PublishedHttpsTransport.Cancellation cancellation;
    final Deadline deadline;
    volatile Socket socket;
    volatile boolean stopped;
    final Thread monitor;
    AbortMonitor(PublishedHttpsTransport.Cancellation cancellation, Deadline deadline) {
      this.cancellation = cancellation; this.deadline = deadline;
      monitor = new Thread(() -> {
        while (!stopped) {
          try {
            if ((cancellation != null && cancellation.isCancelled()) || deadline.expired()) {
              closeSocket(); return;
            }
            Thread.sleep(20L);
          } catch (InterruptedException stoppedThread) { return; }
          catch (RuntimeException failure) { closeSocket(); return; }
        }
      }, "napplet-wss-cancel");
      monitor.setDaemon(true);
      monitor.start();
    }
    void setSocket(Socket value) throws IOException {
      socket = value;
      // Lifecycle cancellation closes raw TCP immediately. SSLSocket.close can write
      // close_notify, which belongs to worker cleanup rather than the Android UI thread.
      if (cancellation instanceof StreamControl && !(value instanceof SSLSocket)) ((StreamControl) cancellation).attach(value);
      if (cancellation instanceof PublishedRelayWssQuery.PublicationControl && !(value instanceof SSLSocket)) {
        ((PublishedRelayWssQuery.PublicationControl) cancellation).attach(value);
      }
      check();
    }
    void check() throws IOException {
      if (deadline.expired()) { closeSocket(); throw new SocketTimeoutException("Relay query timed out"); }
      if (cancellation != null) {
        try {
          if (cancellation.isCancelled()) { closeSocket(); throw new IOException("Relay query cancelled"); }
        } catch (RuntimeException unavailable) {
          closeSocket();
          throw new IOException("Relay cancellation state unavailable", unavailable);
        }
      }
    }
    void closeSocket() { Socket current = socket; if (current != null) try { current.close(); } catch (IOException ignored) {} }
    @Override public void close() {
      stopped = true; monitor.interrupt(); closeSocket();
      try { monitor.join(100L); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    }
  }
}
