package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import org.nostrocket.hypergolic.host.PublishedRelayWssIo.AbortMonitor;
import org.nostrocket.hypergolic.host.PublishedRelayWssIo.DeadlineInput;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.Deadline;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.PublicationControl;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.RelayUrl;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.SendAction;

/** Opens a native signer socket through the shared public DNS, TLS and handshake policy. */
final class NativeSignerRelayOpening {
  private NativeSignerRelayOpening() {}
  /** Native signer opening hooks; all budget/control calls return before socket I/O. */
  interface OpenControl extends PublishedHttpsTransport.Cancellation {
    void attach(Socket raw) throws IOException;
    int reserveRead(int wanted) throws IOException;
    void finishRead(int reserved, int received);
    void beforeWrite(int bytes) throws IOException;
  }
  static class RelayTransport {
    final PublishedHttpsTransport.AddressPolicy policy;
    final PublishedHttpsTransport.HostResolver resolver;
    final ThreadPoolExecutor executor;
    final SSLSocketFactory factory;
    final HostnameVerifier verifier;
    RelayTransport(PublishedHttpsTransport.AddressPolicy policy, PublishedHttpsTransport.HostResolver resolver,
        ThreadPoolExecutor executor, SSLSocketFactory factory, HostnameVerifier verifier) {
      if (policy == null || resolver == null || executor == null || factory == null || verifier == null) {
        throw new IllegalArgumentException("Missing relay transport");
      }
      this.policy = policy; this.resolver = resolver; this.executor = executor;
      this.factory = factory; this.verifier = verifier;
    }
  }
  static final class OpenRelay implements AutoCloseable {
    final DeadlineInput input;
    final OutputStream output;
    final AbortMonitor abort;
    final Socket raw;
    OpenRelay(DeadlineInput input, OutputStream output, AbortMonitor abort, Socket raw) {
      this.input = input; this.output = output; this.abort = abort; this.raw = raw;
    }
    @Override public void close() {
      try { raw.close(); } catch (IOException ignored) {}
      abort.close();
    }
  }
  static OpenRelay openRelay(String rawUrl, OpenControl control, Deadline deadline) throws IOException {
    return openRelay(rawUrl, control, deadline, new RelayTransport(PublishedHttpsRequestOwner.addressPolicy(),
        InetAddress::getAllByName, PublishedRelayWssQuery.DNS, PublishedRelayWssQuery.defaultFactory(), HttpsURLConnection.getDefaultHostnameVerifier()));
  }
  /** Controlled package-local route; production callers cannot override DNS/TLS inputs. */
  static OpenRelay openRelay(String rawUrl, OpenControl control, Deadline deadline, RelayTransport transport) throws IOException {
    RelayUrl relay = PublishedRelayWssQuery.parseUrl(rawUrl);
    if (control == null || deadline == null || transport == null) throw new IOException("Missing native relay owner");
    if (!transport.policy.isAllowedHost(relay.host)) throw new IOException("Unsafe relay hostname");
    AtomicReference<Socket> raw = new AtomicReference<>();
    PublicationControl monitorControl = openingControl(control, deadline, raw);
    AbortMonitor abort = new AbortMonitor(monitorControl, deadline);
    boolean opened = false;
    try {
      InetAddress[] addresses = PublishedRelayWssQuery.checkedAddresses(PublishedRelayWssQuery.resolve(relay.host, deadline, abort, transport.resolver, transport.executor), transport.policy);
      SSLSocket tls = PublishedRelayWssQuery.connect(relay, addresses, transport.policy, abort, deadline, transport.factory, transport.verifier);
      DeadlineInput input = new DeadlineInput(accountedInput(tls.getInputStream(), control), tls, deadline);
      OutputStream output = tls.getOutputStream();
      byte[] nonce = new byte[16]; PublishedRelayWssQuery.RANDOM.nextBytes(nonce);
      abort.check();
      PublishedRelayWssQuery.sendHandshake(new OutputStream() {
        @Override public void write(int value) throws IOException { control.beforeWrite(1); output.write(value); }
        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
          control.beforeWrite(length); output.write(bytes, offset, length);
        }
        @Override public void flush() throws IOException { output.flush(); }
      }, relay, nonce);
      PublishedRelayWebSocketHandshake.validate(PublishedRelayWssQuery.readHandshake(input, abort), nonce);
      abort.check();
      OpenRelay result = new OpenRelay(input, output, abort, raw.get());
      opened = true;
      return result;
    } catch (IllegalArgumentException invalid) { throw new IOException("Invalid native relay upgrade", invalid); }
    finally {
      if (!opened) { Socket tcp = raw.get(); if (tcp != null) try { tcp.close(); } catch (IOException ignored) {} abort.close(); }
    }
  }
  private static PublicationControl openingControl(OpenControl control, Deadline deadline, AtomicReference<Socket> raw) {
    return new PublicationControl() {
      @Override public void attach(Socket socket) throws IOException { raw.set(socket); control.attach(socket); }
      @Override public boolean isCancelled() {
        boolean cancelled;
        try { cancelled = control.isCancelled() || deadline.expired(); }
        catch (RuntimeException unavailable) { closeRaw(); throw unavailable; }
        if (cancelled) closeRaw();
        return cancelled;
      }
      private void closeRaw() { Socket tcp = raw.get(); if (tcp != null) try { tcp.close(); } catch (IOException ignored) {} }
      @Override public void send(SendAction unused) throws IOException { throw new IOException("Native relay opener cannot dispatch requests"); }
    };
  }
  private static InputStream accountedInput(InputStream input, OpenControl control) {
    return new InputStream() {
      @Override public int read() throws IOException {
        int reserved = control.reserveRead(1);
        int value = input.read();
        control.finishRead(reserved, value < 0 ? 0 : 1);
        return value;
      }
      @Override public int read(byte[] bytes, int offset, int length) throws IOException {
        if (length == 0) return 0;
        int reserved = control.reserveRead(length);
        int received = input.read(bytes, offset, reserved);
        control.finishRead(reserved, Math.max(0, received));
        return received;
      }
    };
  }
}
