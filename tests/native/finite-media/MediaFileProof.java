package org.nostrocket.hypergolic.host;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.SequenceInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

final class MediaFileProof {
  private static final int LARGE = 168_532_851;
  private static final String HEAD = "HTTP/1.1 200 OK\r\n";
  private static final String[] INVALID = {
      HEAD, HEAD + "Content-Length: 3\r\nContent-Length: 3\r\n",
      HEAD + "Content-Length: 0\r\n", HEAD + "Content-Length: 268435457\r\n",
      HEAD + "Content-Length: +3\r\n", HEAD + "Content-Length: 3,3\r\n",
      HEAD + "Transfer-Encoding: chunked\r\n",
      HEAD + "Content-Length: 3\r\nTransfer-Encoding: chunked\r\n",
      HEAD + "Content-Length: 3\r\nContent-Encoding: gzip\r\n",
      HEAD + "Content-Length: 3\r\nContent-Range: bytes 0-2/3\r\n",
      HEAD + "Content-Length: 3\r\nConnection: keep-alive\r\n",
      HEAD + "Content-Length: 3\r\nX-Invalid: \0\r\n",
      "HTTP/1.0 200 OK\r\nContent-Length: 3\r\n",
      "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\n",
      "HTTP/1.1 302 Found\r\nLocation: https://other.example.org/video.mp4\r\nLocation: /other\r\n",
  };

  public static void main(String[] args) throws Exception {
    proveIdleClock();
    File destination = Path.of(args[0], "java-video.mp4").toFile();
    for (int i = 1; i < args.length; i++) {
      File file = new File(args[i]);
      int[] windows = {0};
      boolean valid = FiniteMp4.accepts(file, () -> windows[0]++);
      require(valid == file.getName().startsWith("ok-"), file.getName());
      if (file.getName().equals("ok-mdat-before-moov")) require(windows[0] <= 3, "large mdat was not skipped");
    }

    for (String head : INVALID) reject(response(head, new PatternInput(3)), destination, () -> {});
    reject(response(HEAD + "Content-Length: 3\r\n", new PatternInput(2)), destination, () -> {});
    reject(response(HEAD + "Content-Length: 3\r\n", new PatternInput(4)), destination, () -> {});
    var expired = PublishedHttpsTransport.Deadline.afterMillis(0);
    reject(response(HEAD + "Content-Length: 3\r\n", new PatternInput(3)), destination, () -> expired.timeoutMs(1000));

    try {
      MediaHttpsFile.readResponse(response("HTTP/1.1 302 Found\r\nLocation: /target\r\n", new PatternInput(0)),
          destination, () -> {}, (n, total) -> { throw new AssertionError("redirect began a file"); });
      throw new AssertionError("Expected redirect");
    } catch (PublishedHttpsResponseReader.ResourceRedirect redirect) {
      require(redirect.location.equals("/target") && !destination.exists(), "redirect must not stage a file");
    }
    var body = new PatternInput(LARGE);
    reject(response(HEAD + "Content-Length: " + LARGE + "\r\n", body), destination, () -> {
      if (body.remaining < LARGE - 32768) throw new IOException("revoked");
    });
    require(body.remaining > 0, "revocation checked only after receiving all bytes");

    var last = new int[]{-1};
    MediaHttpsFile.readResponse(response(HEAD + "Content-Length: " + LARGE + "\r\nContent-Encoding: identity\r\n",
        new PatternInput(LARGE)), destination, () -> {}, (n, total) -> {
      require(total == LARGE && n > last[0], "invalid progress");
      last[0] = n;
    });
    require(destination.length() == LARGE && last[0] == LARGE, "short or missing large staging file");
    try {
      MediaHttpsFile.readResponse(response(HEAD + "Content-Length: 3\r\n", new PatternInput(3)), destination, () -> {}, (n, total) -> {});
      throw new AssertionError("overwrote staged file");
    } catch (IOException expected) {
      require(destination.length() == LARGE, "overlapping stage damaged the existing file");
    }
    Files.delete(destination.toPath());
    System.out.println("Android bounded 161 MiB copy passed on a 24 MiB Java heap, with malformed, expiry and cancellation cases.");
  }

  private static void proveIdleClock() throws IOException {
    long[] time = {0};
    var idle = new PublishedHttpsResponseReader.TransferIdle(MediaHttpsFile.IDLE_MS, () -> time[0]);
    time[0] += 9_000_000_000L;
    require(!idle.expired(), "idle expired before first body progress");
    idle.progress();
    time[0] += 9_000_000_000L;
    require(!idle.expired(), "valid progress did not extend idle time");
    time[0] += 1_000_000_000L;
    require(idle.expired(), "no progress left idle open past the limit");
    try { idle.progress(); throw new AssertionError("late data revived idle transfer"); }
    catch (java.net.SocketTimeoutException expected) { require(idle.expired(), "expired transfer revived"); }
  }

  private static InputStream response(String head, InputStream body) {
    return new SequenceInputStream(new ByteArrayInputStream((head + "\r\n").getBytes(StandardCharsets.US_ASCII)), body);
  }

  private static void reject(InputStream input, File destination, MediaHttpsFile.Check check) throws Exception {
    try {
      MediaHttpsFile.readResponse(input, destination, check, (n, total) -> {});
      throw new AssertionError("Invalid body was accepted");
    } catch (IOException expected) {
      require(!destination.exists(), "failed transfer retained its file");
    }
  }

  private static void require(boolean value, String description) {
    if (!value) throw new AssertionError(description);
  }

  private static final class PatternInput extends InputStream {
    int remaining;
    PatternInput(int remaining) { this.remaining = remaining; }
    @Override public int read() { return remaining-- > 0 ? 42 : -1; }
    @Override public int read(byte[] buffer, int offset, int length) {
      require(buffer.length <= 64 * 1024, "unbounded transfer buffer");
      int n = Math.min(length, remaining);
      if (n <= 0) return -1;
      java.util.Arrays.fill(buffer, offset, offset + n, (byte)42);
      remaining -= n;
      return n;
    }
  }
}
