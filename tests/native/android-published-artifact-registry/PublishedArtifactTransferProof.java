package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;

public final class PublishedArtifactTransferProof {
  private static int assertions;
  private static void check(boolean condition) {
    assertions++;
    if (!condition) throw new AssertionError("Transfer assertion " + assertions);
  }
  private static final String SESSION = "session-a";
  private static final String PUBLISHER = "ab".repeat(32);
  private static final String EVENT = "cd".repeat(32);
  private static final String VIEW = "123e4567-e89b-12d3-a456-426614174000";

  private static final class Fixture {
    long now;
    final PublishedArtifactRegistry registry = new PublishedArtifactRegistry(() -> now, new SecureRandom());
    final PublishedArtifactTransfer transfer = new PublishedArtifactTransfer(registry, () -> now, new SecureRandom());
  }

  private static final class Claims {
    final byte[] bytes;
    final String htmlHash, aggregateHash;
    Claims(byte[] bytes) {
      this.bytes = bytes;
      this.htmlHash = hash(bytes);
      this.aggregateHash = hash((htmlHash + " /index.html\n").getBytes(StandardCharsets.US_ASCII));
    }
    String begin(Fixture f, String session) {
      return f.transfer.beginPublishedArtifact(session, PUBLISHER, "published-test", EVENT,
          aggregateHash, htmlHash, bytes.length);
    }
  }

  private static String hash(byte[] bytes) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
      StringBuilder out = new StringBuilder();
      for (byte value : digest) out.append(String.format("%02x", value & 0xff));
      return out.toString();
    } catch (Exception e) { throw new IllegalStateException(e); }
  }

  private static String encode(byte[] bytes) { return Base64.getEncoder().encodeToString(bytes); }

  private static void genuineBytesAndReplay() {
    Fixture f = new Fixture();
    Claims c = new Claims("<!doctype html><meta charset=utf-8><p>é</p>".getBytes(StandardCharsets.UTF_8));
    check(c.begin(f, SESSION) == null);
    check(f.transfer.registerPublishedSession(SESSION));
    check(!f.transfer.registerPublishedSession(SESSION));
    String id = c.begin(f, SESSION);
    check(id != null && id.length() >= 32);
    check(c.begin(f, SESSION) == null);
    int cut = 17;
    check(f.transfer.appendPublishedArtifact(id, 0, encode(Arrays.copyOfRange(c.bytes, 0, cut))));
    check(f.transfer.appendPublishedArtifact(id, 1, encode(Arrays.copyOfRange(c.bytes, cut, c.bytes.length))));
    String token = f.transfer.finishPublishedArtifact(id);
    check(token != null && !token.equals(id));
    check(f.transfer.finishPublishedArtifact(id) == null);
    check(!f.transfer.appendPublishedArtifact(id, 2, encode(new byte[]{1})));
    PublishedArtifactRegistry.ClaimedArtifact claim = f.registry.claim(token, SESSION, PUBLISHER,
        "published-test", EVENT, c.aggregateHash, c.htmlHash, VIEW);
    check(claim != null && Arrays.equals(claim.takeHtmlBytes(), c.bytes));
    check(f.registry.claim(token, SESSION, PUBLISHER, "published-test", EVENT,
        c.aggregateHash, c.htmlHash, VIEW) == null);
  }

  private static void invalidChunksConsume() {
    Fixture f = new Fixture(); check(f.transfer.registerPublishedSession(SESSION));
    Claims c = new Claims("abc".getBytes(StandardCharsets.UTF_8));
    String id = c.begin(f, SESSION);
    check(!f.transfer.appendPublishedArtifact(id, 1, "YQ=="));
    check(f.transfer.finishPublishedArtifact(id) == null);
    id = c.begin(f, SESSION);
    check(!f.transfer.appendPublishedArtifact(id, 0, "YR==")); // Noncanonical pad bits.
    check(f.transfer.finishPublishedArtifact(id) == null);
    id = c.begin(f, SESSION);
    check(!f.transfer.appendPublishedArtifact(id, 0, "YQ")); // Missing padding.
    check(f.transfer.finishPublishedArtifact(id) == null);
    id = c.begin(f, SESSION);
    check(!f.transfer.appendPublishedArtifact(id, 0, "!!!!"));
    check(f.transfer.finishPublishedArtifact(id) == null);
    id = c.begin(f, SESSION);
    check(!f.transfer.appendPublishedArtifact(id, 0, encode(new byte[4]))); // Declared overflow.
    check(f.transfer.finishPublishedArtifact(id) == null);
    id = c.begin(f, SESSION);
    check(!f.transfer.appendPublishedArtifact(id, 0, encode(new byte[PublishedArtifactTransfer.MAX_CHUNK_BYTES + 1])));
    check(f.transfer.finishPublishedArtifact(id) == null);
    id = c.begin(f, SESSION);
    check(!f.transfer.appendPublishedArtifact(id, 0, ""));
    check(f.transfer.finishPublishedArtifact(id) == null);
  }

  private static void lengthIntegrityAndLifecycle() {
    Fixture f = new Fixture(); check(f.transfer.registerPublishedSession(SESSION));
    Claims c = new Claims("correct".getBytes(StandardCharsets.UTF_8));
    String id = c.begin(f, SESSION);
    check(f.transfer.appendPublishedArtifact(id, 0, encode("short".getBytes(StandardCharsets.UTF_8))));
    check(f.transfer.finishPublishedArtifact(id) == null);
    id = c.begin(f, SESSION);
    check(f.transfer.appendPublishedArtifact(id, 0, encode("wrong!!".getBytes(StandardCharsets.UTF_8))));
    check(f.transfer.finishPublishedArtifact(id) == null); // Registry hash check.
    id = c.begin(f, SESSION);
    f.transfer.cancelPublishedArtifact(id);
    check(f.transfer.finishPublishedArtifact(id) == null);
    id = c.begin(f, SESSION);
    f.transfer.revokePublishedSession(SESSION);
    check(f.transfer.finishPublishedArtifact(id) == null);
    check(c.begin(f, SESSION) == null);
    check(f.transfer.registerPublishedSession(SESSION));
    id = c.begin(f, SESSION);
    f.transfer.revokeAllPublishedArtifacts();
    check(f.transfer.finishPublishedArtifact(id) == null);
    check(c.begin(f, SESSION) == null);
  }

  private static void admissionCapacityAndExpiry() {
    Fixture f = new Fixture(); Claims c = new Claims(new byte[]{'a'});
    check(f.transfer.registerPublishedSession(SESSION));
    check(f.transfer.beginPublishedArtifact(SESSION, "AA".repeat(32), "published-test", EVENT,
        c.aggregateHash, c.htmlHash, 1) == null);
    check(f.transfer.beginPublishedArtifact(SESSION, PUBLISHER, "bad\nname", EVENT,
        c.aggregateHash, c.htmlHash, 1) == null);
    check(f.transfer.beginPublishedArtifact(SESSION, PUBLISHER, "published-test", EVENT,
        c.aggregateHash, c.htmlHash, 0) == null);
    check(f.transfer.beginPublishedArtifact(SESSION, PUBLISHER, "published-test", EVENT,
        c.aggregateHash, c.htmlHash, PublishedArtifactRegistry.MAX_HTML_BYTES + 1) == null);
    String[] ids = new String[PublishedArtifactTransfer.MAX_ACTIVE_UPLOADS];
    ids[0] = c.begin(f, SESSION); check(ids[0] != null);
    for (int i = 1; i < ids.length; i++) {
      String session = "session-" + i;
      check(f.transfer.registerPublishedSession(session));
      ids[i] = c.begin(f, session);
      check(ids[i] != null);
    }
    check(f.transfer.registerPublishedSession("session-fifth"));
    check(c.begin(f, "session-fifth") == null);
    f.now = PublishedArtifactTransfer.MAX_UPLOAD_LIFETIME_MS - 1;
    check(f.transfer.appendPublishedArtifact(ids[0], 0, "YQ=="));
    check(f.transfer.finishPublishedArtifact(ids[0]) != null);
    f.now = PublishedArtifactTransfer.MAX_UPLOAD_LIFETIME_MS;
    check(f.transfer.finishPublishedArtifact(ids[1]) == null);
    check(f.transfer.appendPublishedArtifact(ids[2], 0, "YQ==") == false);
    check(c.begin(f, "session-fifth") != null);
  }

  private static void exactMaximumUsesBoundedChunks() {
    Fixture f = new Fixture(); check(f.transfer.registerPublishedSession(SESSION));
    byte[] bytes = new byte[PublishedArtifactRegistry.MAX_HTML_BYTES];
    Arrays.fill(bytes, (byte) 'x');
    Claims c = new Claims(bytes);
    String id = c.begin(f, SESSION);
    check(id != null);
    int sequence = 0;
    for (int at = 0; at < bytes.length; at += PublishedArtifactTransfer.MAX_CHUNK_BYTES) {
      int end = Math.min(bytes.length, at + PublishedArtifactTransfer.MAX_CHUNK_BYTES);
      check(f.transfer.appendPublishedArtifact(id, sequence++, encode(Arrays.copyOfRange(bytes, at, end))));
    }
    String token = f.transfer.finishPublishedArtifact(id);
    check(token != null);
    PublishedArtifactRegistry.ClaimedArtifact claim = f.registry.claim(token, SESSION, PUBLISHER,
        "published-test", EVENT, c.aggregateHash, c.htmlHash, VIEW);
    check(claim != null && Arrays.equals(claim.takeHtmlBytes(), bytes));
  }

  public static void main(String[] args) {
    check(PublishedArtifactTransfer.INSTANCE.registerPublishedSession("default-transfer-test"));
    PublishedArtifactTransfer.INSTANCE.revokePublishedSession("default-transfer-test");
    genuineBytesAndReplay();
    invalidChunksConsume();
    lengthIntegrityAndLifecycle();
    admissionCapacityAndExpiry();
    exactMaximumUsesBoundedChunks();
    System.out.println("{\"status\":\"passed\",\"assertions\":" + assertions + "}");
  }
}
