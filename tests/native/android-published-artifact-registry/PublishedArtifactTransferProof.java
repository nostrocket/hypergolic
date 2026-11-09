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
    byte[] bytes = new byte[20 * 1024 * 1024];
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

  private static void boundsReservedAndStagedArtifactBytes() {
    Fixture f = new Fixture();
    Claims large = new Claims(new byte[20 * 1024 * 1024]);
    Claims remainder = new Claims(new byte[12 * 1024 * 1024]);
    Claims small = new Claims(new byte[] {'a'});
    String one = "max-one", two = "max-two", three = "max-three";
    check(f.transfer.registerPublishedSession(one));
    check(f.transfer.registerPublishedSession(two));
    check(f.transfer.registerPublishedSession(three));
    String first = large.begin(f, one);
    check(large.begin(f, two) == null);
    String second = remainder.begin(f, two);
    check(first != null && second != null);
    check(small.begin(f, three) == null);
    f.transfer.cancelPublishedArtifact(first);
    check(small.begin(f, three) != null);

    check(f.registry.stage(large.bytes, one, PUBLISHER, "published-test", EVENT, large.aggregateHash, large.htmlHash) != null);
    check(f.registry.stage(large.bytes, two, PUBLISHER, "published-test", EVENT, large.aggregateHash, large.htmlHash) == null);
    check(f.registry.stage(remainder.bytes, two, PUBLISHER, "published-test", EVENT, remainder.aggregateHash, remainder.htmlHash) != null);
    check(f.registry.stage(small.bytes, three, PUBLISHER, "published-test", EVENT, small.aggregateHash, small.htmlHash) == null);
    f.registry.revokeSession(one);
    check(f.registry.stage(small.bytes, three, PUBLISHER, "published-test", EVENT, small.aggregateHash, small.htmlHash) != null);
    f.transfer.revokeAllPublishedArtifacts();
  }

  private static String stageSnapshot(Fixture fixture, Claims bytes, String title) {
    String upload = fixture.transfer.beginPublishedSnapshot(SESSION, PUBLISHER, EVENT,
        title, bytes.aggregateHash, bytes.htmlHash, bytes.bytes.length);
    check(upload != null);
    int cut = 13;
    check(fixture.transfer.appendPublishedArtifact(upload, 0, encode(Arrays.copyOfRange(bytes.bytes, 0, cut))));
    check(fixture.transfer.appendPublishedArtifact(upload, 1, encode(Arrays.copyOfRange(bytes.bytes, cut, bytes.bytes.length))));
    String handle = fixture.transfer.finishPublishedArtifact(upload);
    check(handle != null);
    return handle;
  }

  private static void snapshotGenerationAndClaims() {
    Fixture f = new Fixture();
    Claims c = new Claims("<html>immutable snapshot</html>".getBytes(StandardCharsets.UTF_8));
    String title = "Snapshot café";
    PublishedArtifactRegistry.Snapshot snapshot = PublishedArtifactRegistry.Snapshot.create(EVENT, title);
    String key = " 5129:" + EVENT;
    check(snapshot != null && snapshot.appKey().equals(key));
    check(f.transfer.registerPublishedSession(SESSION));
    check(f.transfer.beginPublishedArtifact(SESSION, PUBLISHER, key, EVENT,
        c.aggregateHash, c.htmlHash, c.bytes.length) == null);
    String named = f.transfer.beginPublishedArtifact(SESSION, PUBLISHER, key.trim(), EVENT,
        c.aggregateHash, c.htmlHash, c.bytes.length);
    check(named != null);
    f.transfer.cancelPublishedArtifact(named);

    for (String invalid : new String[]{"", " a", "a  b", "a\nb", "a\u202Eb", "é".repeat(65)}) {
      check(f.transfer.beginPublishedSnapshot(SESSION, PUBLISHER, EVENT, invalid,
          c.aggregateHash, c.htmlHash, c.bytes.length) == null);
    }
    check(f.transfer.beginPublishedSnapshot(SESSION, PUBLISHER, EVENT.toUpperCase(), title,
        c.aggregateHash, c.htmlHash, c.bytes.length) == null);

    String handle = stageSnapshot(f, c, title);
    check(f.transfer.claimForHost(handle, SESSION, PUBLISHER, key.trim(), EVENT,
        c.aggregateHash, c.htmlHash, snapshot, VIEW) == null);
    check(f.transfer.claimForHost(handle, SESSION, PUBLISHER, key, EVENT,
        c.aggregateHash, c.htmlHash, snapshot, VIEW) == null);
    check(f.transfer.claimForHost(stageSnapshot(f, c, title), SESSION, PUBLISHER, key, "e".repeat(64),
        c.aggregateHash, c.htmlHash, snapshot, VIEW) == null);
    check(f.transfer.claimForHost(stageSnapshot(f, c, title), SESSION, "e".repeat(64), key, EVENT,
        c.aggregateHash, c.htmlHash, snapshot, VIEW) == null);
    check(f.transfer.claimForHost(stageSnapshot(f, c, title), SESSION, PUBLISHER, key, EVENT,
        c.aggregateHash, c.htmlHash, PublishedArtifactRegistry.Snapshot.create(EVENT, "Snapshot cafe\u0301"), VIEW) == null);
    check(f.transfer.claimForHost(stageSnapshot(f, c, title), SESSION, PUBLISHER, key, EVENT,
        c.aggregateHash, c.htmlHash, snapshot, "guest-generation") == null);
    handle = stageSnapshot(f, c, title);
    Fixture restarted = new Fixture();
    check(restarted.transfer.registerPublishedSession(SESSION));
    check(restarted.transfer.claimForHost(handle, SESSION, PUBLISHER, key, EVENT,
        c.aggregateHash, c.htmlHash, snapshot, VIEW) == null);
    f.transfer.revokePublishedSession(SESSION);
    check(f.transfer.registerPublishedSession(SESSION));
    check(f.transfer.claimForHost(handle, SESSION, PUBLISHER, key, EVENT,
        c.aggregateHash, c.htmlHash, snapshot, VIEW) == null);
    String cancelled = f.transfer.beginPublishedSnapshot(SESSION, PUBLISHER, EVENT, title,
        c.aggregateHash, c.htmlHash, c.bytes.length);
    check(cancelled != null);
    f.transfer.cancelPublishedArtifact(cancelled);
    check(!f.transfer.appendPublishedArtifact(cancelled, 0, encode(c.bytes)));
    check(f.transfer.finishPublishedArtifact(cancelled) == null);
    handle = stageSnapshot(f, c, title);
    PublishedArtifactRegistry.ClaimedArtifact claimed = f.transfer.claimForHost(handle, SESSION, PUBLISHER,
        key, EVENT, c.aggregateHash, c.htmlHash, snapshot, VIEW);
    check(claimed != null && claimed.getViewGeneration().equals(VIEW));
    check(Arrays.equals(claimed.takeHtmlBytes(), c.bytes) && claimed.takeHtmlBytes() == null);
    check(claimed.getSnapshot().requester(PUBLISHER).equals(
        "Snapshot (kind 5129): " + title + "\nManifest event ID: " + EVENT + "\nPublisher: " + PUBLISHER));
  }

  public static void main(String[] args) {
    snapshotGenerationAndClaims();
    check(PublishedArtifactTransfer.INSTANCE.registerPublishedSession("default-transfer-test"));
    PublishedArtifactTransfer.INSTANCE.revokePublishedSession("default-transfer-test");
    genuineBytesAndReplay();
    invalidChunksConsume();
    lengthIntegrityAndLifecycle();
    admissionCapacityAndExpiry();
    exactMaximumUsesBoundedChunks();
    boundsReservedAndStagedArtifactBytes();
    System.out.println("{\"status\":\"passed\",\"assertions\":" + assertions + "}");
  }
}
