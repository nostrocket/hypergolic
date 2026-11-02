package org.nostrocket.hypergolic.host;

import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.function.LongSupplier;

/** Bounded, app-only chunk transport into the one-use native artifact registry. */
public final class PublishedArtifactTransfer {
  public static final int MAX_CHUNK_BYTES = 48 * 1024;
  public static final int MAX_ACTIVE_UPLOADS = 4;
  public static final long MAX_UPLOAD_LIFETIME_MS = 60_000L;
  public static final PublishedArtifactTransfer INSTANCE = new PublishedArtifactTransfer();
  private static final int ID_BYTES = 32;

  private static final class Upload {
    final String sessionId, publisher, identifier, eventId, aggregateHash, htmlHash;
    final long expiresAt;
    final byte[] bytes;
    int length, nextSequence;

    Upload(String sessionId, String publisher, String identifier, String eventId,
        String aggregateHash, String htmlHash, long expiresAt, int byteLength) {
      this.sessionId = sessionId;
      this.publisher = publisher;
      this.identifier = identifier;
      this.eventId = eventId;
      this.aggregateHash = aggregateHash;
      this.htmlHash = htmlHash;
      this.expiresAt = expiresAt;
      this.bytes = new byte[byteLength];
    }

    void clear() { Arrays.fill(bytes, (byte) 0); }
  }

  private final PublishedArtifactRegistry registry;
  private final LongSupplier clock;
  private final SecureRandom random;
  private final Map<String, Upload> uploads = new HashMap<>();
  private long lastTime;
  private boolean hasTime, clockFailed;

  public PublishedArtifactTransfer() {
    this(new PublishedArtifactRegistry(), new LongSupplier() {
      private final long origin = System.nanoTime();
      @Override public long getAsLong() { return (System.nanoTime() - origin) / 1_000_000L; }
    }, new SecureRandom());
  }

  /** Package-private deterministic seam for the owning JVM proof. */
  PublishedArtifactTransfer(PublishedArtifactRegistry registry, LongSupplier clock, SecureRandom random) {
    if (registry == null || clock == null || random == null) throw new IllegalArgumentException("Missing transfer dependency");
    this.registry = registry;
    this.clock = clock;
    this.random = random;
  }

  public synchronized boolean registerPublishedSession(String sessionId) {
    return now() >= 0 && registry.registerSession(sessionId);
  }

  public synchronized String beginPublishedArtifact(String sessionId, String publisher, String identifier,
      String eventId, String aggregateHash, String htmlHash, int byteLength) {
    long time = now();
    if (time < 0 || byteLength < 1 || byteLength > PublishedArtifactRegistry.MAX_HTML_BYTES ||
        time > Long.MAX_VALUE - MAX_UPLOAD_LIFETIME_MS || !registry.hasSession(sessionId) ||
        !PublishedArtifactRegistry.validClaims(publisher, identifier, eventId, aggregateHash, htmlHash)) return null;
    prune(time);
    if (uploads.size() >= MAX_ACTIVE_UPLOADS) return null;
    for (Upload upload : uploads.values()) if (upload.sessionId.equals(sessionId)) return null;
    String uploadId = newUploadId();
    if (uploadId == null) return null;
    uploads.put(uploadId, new Upload(sessionId, publisher, identifier, eventId,
        aggregateHash, htmlHash, time + MAX_UPLOAD_LIFETIME_MS, byteLength));
    return uploadId;
  }

  public synchronized boolean appendPublishedArtifact(String uploadId, int sequence, String base64Chunk) {
    long time = now();
    if (time < 0 || uploadId == null) return false;
    prune(time);
    Upload upload = uploads.get(uploadId);
    if (upload == null) return false;
    if (sequence != upload.nextSequence) return reject(uploadId);
    byte[] chunk = decodeCanonicalChunk(base64Chunk, upload.bytes.length - upload.length);
    if (chunk == null) return reject(uploadId);
    System.arraycopy(chunk, 0, upload.bytes, upload.length, chunk.length);
    upload.length += chunk.length;
    upload.nextSequence++;
    Arrays.fill(chunk, (byte) 0);
    return true;
  }

  /** Consumes the upload even if incomplete or if registry integrity validation fails. */
  public synchronized String finishPublishedArtifact(String uploadId) {
    long time = now();
    if (time < 0 || uploadId == null) return null;
    prune(time);
    Upload upload = uploads.remove(uploadId);
    if (upload == null) return null;
    try {
      if (upload.length != upload.bytes.length || !registry.hasSession(upload.sessionId)) return null;
      return registry.stage(upload.bytes, upload.sessionId, upload.publisher, upload.identifier,
          upload.eventId, upload.aggregateHash, upload.htmlHash);
    } finally { upload.clear(); }
  }

  public synchronized void cancelPublishedArtifact(String uploadId) {
    if (uploadId == null) return;
    Upload upload = uploads.remove(uploadId);
    if (upload != null) upload.clear();
  }

  public synchronized void revokePublishedSession(String sessionId) {
    if (sessionId == null) return;
    Iterator<Map.Entry<String, Upload>> it = uploads.entrySet().iterator();
    while (it.hasNext()) {
      Upload upload = it.next().getValue();
      if (sessionId.equals(upload.sessionId)) { upload.clear(); it.remove(); }
    }
    registry.revokeSession(sessionId);
  }

  public synchronized void revokeAllPublishedArtifacts() {
    for (Upload upload : uploads.values()) upload.clear();
    uploads.clear();
    registry.revokeAll();
  }

  /** Native-view-only claim; never bind this method as an Expo module function. */
  public synchronized PublishedArtifactRegistry.ClaimedArtifact claimForHost(String handle, String sessionId,
      String publisher, String identifier, String eventId, String aggregateHash, String htmlHash,
      String viewGeneration) {
    return registry.claim(handle, sessionId, publisher, identifier, eventId, aggregateHash, htmlHash,
        viewGeneration);
  }

  private boolean reject(String uploadId) {
    cancelPublishedArtifact(uploadId);
    return false;
  }

  private void prune(long time) {
    Iterator<Map.Entry<String, Upload>> it = uploads.entrySet().iterator();
    while (it.hasNext()) {
      Upload upload = it.next().getValue();
      if (time >= upload.expiresAt) { upload.clear(); it.remove(); }
    }
  }

  private long now() {
    final long value;
    try { value = clock.getAsLong(); }
    catch (RuntimeException e) { clockFailed = true; revokeAllPublishedArtifacts(); return -1; }
    if (value < 0 || (hasTime && value < lastTime)) {
      clockFailed = true;
      revokeAllPublishedArtifacts();
      return -1;
    }
    hasTime = true;
    lastTime = value;
    return clockFailed ? -1 : value;
  }

  private String newUploadId() {
    byte[] bytes = new byte[ID_BYTES];
    try {
      for (int attempt = 0; attempt < 4; attempt++) {
        random.nextBytes(bytes);
        String id = hex(bytes);
        if (!uploads.containsKey(id)) return id;
      }
      return null;
    } finally { Arrays.fill(bytes, (byte) 0); }
  }

  private static byte[] decodeCanonicalChunk(String input, int remaining) {
    if (input == null || input.length() < 4 || input.length() > ((MAX_CHUNK_BYTES + 2) / 3) * 4 ||
        (input.length() & 3) != 0) return null;
    int padding = input.charAt(input.length() - 1) == '=' ? 1 : 0;
    if (padding == 1 && input.charAt(input.length() - 2) == '=') padding = 2;
    int length = input.length() / 4 * 3 - padding;
    if (length < 1 || length > MAX_CHUNK_BYTES || length > remaining) return null;
    byte[] bytes = new byte[length];
    int at = 0;
    for (int i = 0; i < input.length(); i += 4) {
      int a = digit(input.charAt(i)), b = digit(input.charAt(i + 1));
      boolean finalGroup = i + 4 == input.length();
      boolean cPadded = finalGroup && padding == 2;
      boolean dPadded = finalGroup && padding >= 1;
      int c = cPadded ? 0 : digit(input.charAt(i + 2));
      int d = dPadded ? 0 : digit(input.charAt(i + 3));
      if (a < 0 || b < 0 || c < 0 || d < 0 ||
          (cPadded && input.charAt(i + 2) != '=') ||
          (dPadded && input.charAt(i + 3) != '=') ||
          (cPadded && (b & 15) != 0) ||
          (dPadded && !cPadded && (c & 3) != 0)) {
        Arrays.fill(bytes, (byte) 0);
        return null;
      }
      bytes[at++] = (byte) ((a << 2) | (b >>> 4));
      if (!cPadded) bytes[at++] = (byte) ((b << 4) | (c >>> 2));
      if (!dPadded) bytes[at++] = (byte) ((c << 6) | d);
    }
    return bytes;
  }

  private static int digit(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  }

  private static String hex(byte[] bytes) {
    char[] digits = "0123456789abcdef".toCharArray();
    char[] out = new char[bytes.length * 2];
    for (int i = 0; i < bytes.length; i++) {
      int value = bytes[i] & 255;
      out[i * 2] = digits[value >>> 4];
      out[i * 2 + 1] = digits[value & 15];
    }
    return new String(out);
  }
}
