package org.nostrocket.hypergolic.host;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Actual owning parser profile; not HTTP connection or upload approval evidence. */
public final class UploadResponseProof {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
  private interface Action { void run() throws IOException; }
  private static void denied(Action action) throws IOException {
    try { action.run(); throw new AssertionError("Invalid response accepted"); } catch (IOException expected) { check(true); }
  }
  private static ByteArrayInputStream wire(int status, String headers, String body) {
    return new ByteArrayInputStream(("HTTP/1.1 " + status + " Fixture\r\n" + headers + "\r\n" + body).getBytes(StandardCharsets.US_ASCII));
  }
  public static void main(String[] args) throws IOException {
    for (int status : new int[]{200, 201}) {
      var response = PublishedHttpsResponseReader.readUpload(wire(status, "Content-Length: 2\r\n", "{}"), () -> false);
      check(response.status == status); check(new String(response.body, StandardCharsets.US_ASCII).equals("{}"));
      check(PublishedHttpsResponseReader.readUpload(wire(status, "Transfer-Encoding: chunked\r\n", "2\r\n{}\r\n0\r\n\r\n"), () -> false).body.length == 2);
    }
    denied(() -> PublishedHttpsResponseReader.read(wire(201, "Content-Length: 2\r\n", "{}"), () -> false));
    denied(() -> PublishedHttpsResponseReader.readBounded(wire(201, "Content-Length: 2\r\n", "{}"), () -> false, 10*1024*1024));
    for (int status : new int[]{202, 204, 400, 401, 402, 403, 409, 413, 415, 429, 500, 503}) {
      try { PublishedHttpsResponseReader.readUpload(wire(status, "Content-Length: 0\r\n", ""), () -> false); throw new AssertionError("Status accepted"); }
      catch (PublishedHttpsResponseReader.UploadStatus error) { check(error.status == status); }
    }
    for (int status : new int[]{301, 302, 303, 307, 308}) denied(() -> PublishedHttpsResponseReader.readUpload(wire(status, "Location: https://other.example.com/upload\r\nContent-Length: 0\r\n", ""), () -> false));
    for (String headers : new String[]{"Content-Length: 2\r\nContent-Length: 2\r\n", "Content-Length: 2\r\nTransfer-Encoding: chunked\r\n",
      "Content-Length: 2\r\nContent-Encoding: gzip\r\n", "Content-Length: 2\r\nLocation: https://other.example.com/upload\r\n",
      "Content-Length: 2\r\nConnection: close\r\nConnection: close\r\n", "Content-Length: 32769\r\n", "Content-Length: 3\r\n"}) {
      denied(() -> PublishedHttpsResponseReader.readUpload(wire(201, headers, "{}"), () -> false));
    }
    for (int status : new int[]{400, 413, 429}) {
      for (String headers : new String[]{"Content-Length: 3\r\n", "Content-Length: 2\r\nContent-Length: 2\r\n",
        "Content-Length: 2\r\nTransfer-Encoding: chunked\r\n"}) {
        try { PublishedHttpsResponseReader.readUpload(wire(status, headers, "{}"), () -> false); throw new AssertionError("Invalid error settled"); }
        catch (PublishedHttpsResponseReader.UploadStatus invalid) { throw new AssertionError("Unframed error became definitive", invalid); }
        catch (IOException expected) { check(true); }
      }
      denied(() -> PublishedHttpsResponseReader.readUpload(wire(status, "Content-Length: 2\r\n", "{}trailing"), () -> false));
    }
    for (int status : new int[]{301,302,303,307,308}) {
      try { PublishedHttpsResponseReader.readRecovery(wire(status, "Location: https://other.example.com/file\r\nContent-Length: 0\r\n", ""), () -> false, 10485760); throw new AssertionError("Redirect not classified"); }
      catch (PublishedHttpsResponseReader.RecoveryRedirect redirect) { check(redirect.location.equals("https://other.example.com/file")); }
      denied(() -> PublishedHttpsResponseReader.readRecovery(wire(status, "Location: https://other.example.com/file\r\nLocation: https://other.example.com/file\r\nContent-Length: 0\r\n", ""), () -> false, 10485760));
    }
    for (int status : new int[]{200,404}) {
      var response = PublishedHttpsResponseReader.readRecovery(wire(status, "Content-Length: 4\r\n", "file"), () -> false, 10485760);
      check(response.status == status); check(new String(response.body, StandardCharsets.US_ASCII).equals("file"));
      denied(() -> PublishedHttpsResponseReader.readRecovery(wire(status, "Content-Length: 5\r\n", "file"), () -> false, 10485760));
      denied(() -> PublishedHttpsResponseReader.readRecovery(wire(status, "Content-Length: 4\r\n", "filetrailing"), () -> false, 10485760));
      denied(() -> PublishedHttpsResponseReader.readRecovery(wire(status, "Content-Length: 4\r\nTransfer-Encoding: chunked\r\n", "file"), () -> false, 10485760));
    }
    for (int status : new int[]{201,401,403,429,500,302}) {
      denied(() -> PublishedHttpsResponseReader.readRecovery(wire(status, "Content-Length: 0\r\n", ""), () -> false, 10485760));
    }
    denied(() -> PublishedHttpsResponseReader.readRecovery(wire(404, "Content-Length: 0\r\n", ""), () -> true, 10485760));
    denied(() -> PublishedHttpsResponseReader.readUpload(wire(201, "Content-Length: 2\r\n", "{}"), () -> true));
    System.out.println("{\"language\":\"Java\",\"uploadResponseChecks\":"+checks+",\"failed\":0}");
  }
}
