package org.nostrocket.hypergolic.host;
import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.net.SocketTimeoutException;
import javax.net.ssl.SSLSocket;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.Deadline;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.StreamControl;
import static org.nostrocket.hypergolic.host.PublishedRelayWssQuery.READ_TIMEOUT_MS;
/** Existing socket I/O helpers shared by query and stream operations. */
final class PublishedRelayWssIo {
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
      socket.setSoTimeout(deadline.timeoutMs(READ_TIMEOUT_MS));
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
