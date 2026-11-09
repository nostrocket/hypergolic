package org.nostrocket.hypergolic.host;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CoderResult;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.util.function.LongSupplier;

/** One-use, app-process-only handoff for bytes already verified by the trusted shell. */
public final class PublishedArtifactRegistry {
  public static final int MAX_HTML_BYTES = 20 * 1024 * 1024;
  static final int MAX_PENDING_BYTES = 32 * 1024 * 1024;
  public static final int MAX_PENDING = 4;
  public static final long MAX_LIFETIME_MS = 60_000L;
  private static final int MAX_SESSIONS = 64;
  private static final int HANDLE_BYTES = 32;
  private static final String SNAPSHOT_PREFIX = " 5129:";

  /** Immutable metadata from the trusted shell's exact-event verification. */
  public static final class Snapshot {
    public final String eventId;
    public final String title;

    private Snapshot(String eventId, String title) {
      this.eventId = eventId;
      this.title = title;
    }

    public static Snapshot create(String eventId, String title) {
      if (!isLowerHex64(eventId) || title == null || title.isEmpty() ||
          title.length() > 128 || title.getBytes(StandardCharsets.UTF_8).length > 128 ||
          !title.equals(title.trim()) || title.contains("  ") ||
          INVALID_TITLE.matcher(title).find()) return null;
      return new Snapshot(eventId, title);
    }

    public String appKey() { return SNAPSHOT_PREFIX + eventId; }

    public String requester(String publisher) {
      return "Snapshot (kind 5129): " + title + "\nManifest event ID: " + eventId + "\nPublisher: " + publisher;
    }

    private static final java.util.regex.Pattern INVALID_TITLE = java.util.regex.Pattern.compile(
        "[\\x{0}-\\x{1f}\\x{7f}-\\x{9f}\\x{a0}\\x{ad}\\x{61c}\\x{1680}\\x{2000}-\\x{200b}" +
        "\\x{200e}\\x{200f}\\x{2028}-\\x{202f}\\x{205f}\\x{2060}\\x{2066}-\\x{206f}\\x{3000}\\x{d800}-\\x{dfff}\\x{feff}]");
  }

  private static boolean sameSnapshot(Snapshot staged, Snapshot claim) {
    if (staged == null || claim == null) return staged == claim;
    return staged.eventId.equals(claim.eventId) && staged.title.equals(claim.title);
  }

  private static final class Entry {
    final String sessionId;
    final String publisher;
    final String identifier;
    final String eventId;
    final String aggregateHash;
    final String htmlHash;
    final Snapshot snapshot;
    final long expiresAt;
    final byte[] html;

    Entry(String sessionId, String publisher, String identifier, String eventId,
        String aggregateHash, String htmlHash, Snapshot snapshot, long expiresAt, byte[] html) {
      this.sessionId = sessionId;
      this.publisher = publisher;
      this.identifier = identifier;
      this.eventId = eventId;
      this.aggregateHash = aggregateHash;
      this.htmlHash = htmlHash;
      this.snapshot = snapshot;
      this.expiresAt = expiresAt;
      this.html = html;
    }

    void clear() { Arrays.fill(html, (byte) 0); }
  }

  /** Private copy plus the native host generation to which a successful claim is bound. */
  public static final class ClaimedArtifact {
    private final String viewGeneration;
    private final Snapshot snapshot;
    private byte[] html;

    private ClaimedArtifact(String viewGeneration, Snapshot snapshot, byte[] html) {
      this.snapshot = snapshot;
      this.viewGeneration = viewGeneration;
      this.html = html;
    }

    public String getViewGeneration() { return viewGeneration; }
    public Snapshot getSnapshot() { return snapshot; }
    /** Transfers the sole claimed byte buffer to its native view owner; the owner must clear it on teardown. */
    public synchronized byte[] takeHtmlBytes() {
      byte[] result = html;
      html = null;
      return result;
    }
  }

  private final LongSupplier clock;
  private final SecureRandom random;
  private final Map<String, Entry> pending = new HashMap<>();
  private final Set<String> activeSessions = new HashSet<>();
  private long lastTime;
  private boolean hasTime;
  private boolean clockFailed;

  public PublishedArtifactRegistry() {
    this(new LongSupplier() {
      private final long origin = System.nanoTime();
      @Override public long getAsLong() { return (System.nanoTime() - origin) / 1_000_000L; }
    }, new SecureRandom());
  }

  /** Package-private deterministic clock seam for the owning JVM proof. */
  PublishedArtifactRegistry(LongSupplier clock, SecureRandom random) {
    if (clock == null || random == null) throw new IllegalArgumentException("Missing registry dependency");
    this.clock = clock;
    this.random = random;
  }

  /** Registers a currently live shell session. Re-register only after retiring the prior session. */
  public synchronized boolean registerSession(String sessionId) {
    if (now() < 0 || !readableSession(sessionId)) return false;
    if (activeSessions.contains(sessionId)) return false;
    if (activeSessions.size() >= MAX_SESSIONS) return false;
    activeSessions.add(sessionId);
    return true;
  }

  /** Internal admission check; staging still rechecks membership and byte integrity. */
  synchronized boolean hasSession(String sessionId) {
    return now() >= 0 && activeSessions.contains(sessionId);
  }

  /** Shared bounded-claim validation for admission and final staging. */
  static boolean validClaims(String publisherHex64, String identifier, String eventIdHex64,
      String aggregateHashHex64, String htmlHashHex64) {
    return validClaims(publisherHex64, identifier, eventIdHex64, aggregateHashHex64, htmlHashHex64, null);
  }

  static boolean validClaims(String publisherHex64, String identifier, String eventIdHex64,
      String aggregateHashHex64, String htmlHashHex64, Snapshot snapshot) {
    boolean identityMatches = snapshot == null ? validIdentifier(identifier)
        : snapshot.appKey().equals(identifier) && snapshot.eventId.equals(eventIdHex64);
    return isLowerHex64(publisherHex64) && identityMatches && isLowerHex64(eventIdHex64) &&
        isLowerHex64(aggregateHashHex64) && isLowerHex64(htmlHashHex64);
  }

  /** Stages an immutable copy and returns an unpredictable opaque handle, or null on any invalid input. */
  public synchronized String stage(byte[] originalUtf8Bytes, String sessionId, String publisherHex64,
      String identifier, String eventIdHex64, String aggregateHashHex64, String htmlHashHex64) {
    return stage(originalUtf8Bytes, sessionId, publisherHex64, identifier, eventIdHex64,
        aggregateHashHex64, htmlHashHex64, null);
  }

  synchronized String stage(byte[] originalUtf8Bytes, String sessionId, String publisherHex64,
      String identifier, String eventIdHex64, String aggregateHashHex64, String htmlHashHex64,
      Snapshot snapshot) {
    long now = now();
    if (now < 0 || !activeSessions.contains(sessionId) ||
        !validClaims(publisherHex64, identifier, eventIdHex64, aggregateHashHex64, htmlHashHex64, snapshot) ||
        originalUtf8Bytes == null || originalUtf8Bytes.length < 1 ||
        originalUtf8Bytes.length > MAX_HTML_BYTES) return null;
    prune(now);
    if (pending.size() >= MAX_PENDING || now > Long.MAX_VALUE - MAX_LIFETIME_MS) return null;
    int reserved = originalUtf8Bytes.length;
    for (Entry entry : pending.values()) reserved += entry.html.length;
    if (reserved > MAX_PENDING_BYTES) return null;

    byte[] privateCopy = originalUtf8Bytes.clone();
    if (!isStrictUtf8(privateCopy) || !constantTimeEquals(hex(sha256(privateCopy)), htmlHashHex64) ||
        !constantTimeEquals(aggregateHash(htmlHashHex64), aggregateHashHex64)) {
      Arrays.fill(privateCopy, (byte) 0);
      return null;
    }

    String handle = newHandle();
    if (handle == null) {
      Arrays.fill(privateCopy, (byte) 0);
      return null;
    }
    pending.put(handle, new Entry(sessionId, publisherHex64, identifier, eventIdHex64,
        aggregateHashHex64, htmlHashHex64, snapshot, now + MAX_LIFETIME_MS, privateCopy));
    return handle;
  }

  /** Atomically consumes any existing handle attempt; mismatches clear its bytes and cannot be retried. */
  public synchronized ClaimedArtifact claim(String handle, String sessionId, String publisherHex64,
      String identifier, String eventIdHex64, String aggregateHashHex64, String htmlHashHex64,
      String viewGeneration) {
    return claim(handle, sessionId, publisherHex64, identifier, eventIdHex64, aggregateHashHex64,
        htmlHashHex64, null, viewGeneration);
  }

  synchronized ClaimedArtifact claim(String handle, String sessionId, String publisherHex64,
      String identifier, String eventIdHex64, String aggregateHashHex64, String htmlHashHex64,
      Snapshot snapshot, String viewGeneration) {
    long now = now();
    if (now < 0 || handle == null) return null;
    prune(now);
    Entry entry = pending.remove(handle);
    if (entry == null) return null;
    if (!activeSessions.contains(entry.sessionId) || !same(entry.sessionId, sessionId) ||
        !same(entry.publisher, publisherHex64) || !same(entry.identifier, identifier) ||
        !same(entry.eventId, eventIdHex64) || !same(entry.aggregateHash, aggregateHashHex64) ||
        !same(entry.htmlHash, htmlHashHex64) || !sameSnapshot(entry.snapshot, snapshot) ||
        !isCanonicalUuid(viewGeneration)) {
      entry.clear();
      return null;
    }
    byte[] result = entry.html.clone();
    entry.clear();
    return new ClaimedArtifact(viewGeneration, entry.snapshot, result);
  }

  /** Revokes every staged artifact and retires this session; callers may register it again later. */
  public synchronized void revokeSession(String sessionId) {
    if (!readableSession(sessionId)) return;
    activeSessions.remove(sessionId);
    Iterator<Map.Entry<String, Entry>> it = pending.entrySet().iterator();
    while (it.hasNext()) {
      Entry entry = it.next().getValue();
      if (sessionId.equals(entry.sessionId)) {
        entry.clear();
        it.remove();
      }
    }
  }

  /** Revokes and clears every pending artifact; suitable for background or identity transitions. */
  public synchronized void revokeAll() {
    clearPending();
    activeSessions.clear();
  }

  private long now() {
    final long value;
    try { value = clock.getAsLong(); }
    catch (RuntimeException e) { clockFailed = true; clearPending(); return -1; }
    if (value < 0 || (hasTime && value < lastTime)) {
      clockFailed = true;
      clearPending();
      return -1;
    }
    hasTime = true;
    lastTime = value;
    return clockFailed ? -1 : value;
  }

  private void prune(long now) {
    Iterator<Map.Entry<String, Entry>> it = pending.entrySet().iterator();
    while (it.hasNext()) {
      Entry entry = it.next().getValue();
      if (now >= entry.expiresAt) {
        entry.clear();
        it.remove();
      }
    }
  }

  private void clearPending() {
    for (Entry entry : pending.values()) entry.clear();
    pending.clear();
  }

  private String newHandle() {
    byte[] bytes = new byte[HANDLE_BYTES];
    for (int attempt = 0; attempt < 4; attempt++) {
      random.nextBytes(bytes);
      String handle = hex(bytes);
      if (!pending.containsKey(handle)) {
        Arrays.fill(bytes, (byte) 0);
        return handle;
      }
    }
    Arrays.fill(bytes, (byte) 0);
    return null;
  }

  private static boolean readableSession(String value) {
    return value != null && value.matches("[A-Za-z0-9_-]{1,80}");
  }

  private static boolean isCanonicalUuid(String value) {
    return value != null && value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
  }

  private static boolean validIdentifier(String value) {
    if (value == null || value.length() == 0 || value.getBytes(StandardCharsets.UTF_8).length > 255 ||
        !value.equals(value.trim())) return false;
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (Character.isISOControl(c) || Character.isSurrogate(c)) {
        if (!Character.isHighSurrogate(c) || i + 1 >= value.length() ||
            !Character.isLowSurrogate(value.charAt(++i))) return false;
      }
    }
    return true;
  }

  private static boolean isLowerHex64(String value) {
    return value != null && value.length() == 64 && value.matches("[0-9a-f]{64}");
  }

  private static boolean isStrictUtf8(byte[] bytes) {
    CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT);
    ByteBuffer input = ByteBuffer.wrap(bytes);
    CharBuffer output = CharBuffer.allocate(4096);
    for (;;) {
      CoderResult result = decoder.decode(input, output, true);
      if (result.isError()) return false;
      output.clear();
      if (result.isUnderflow()) return decoder.flush(output).isUnderflow();
    }
  }

  private static byte[] sha256(byte[] bytes) {
    try { return MessageDigest.getInstance("SHA-256").digest(bytes); }
    catch (Exception e) { throw new IllegalStateException("SHA-256 unavailable", e); }
  }

  private static String aggregateHash(String htmlHash) {
    return hex(sha256((htmlHash + " /index.html\n").getBytes(StandardCharsets.US_ASCII)));
  }

  private static String hex(byte[] bytes) {
    char[] digits = "0123456789abcdef".toCharArray();
    char[] result = new char[bytes.length * 2];
    for (int i = 0; i < bytes.length; i++) {
      int value = bytes[i] & 0xff;
      result[i * 2] = digits[value >>> 4];
      result[i * 2 + 1] = digits[value & 15];
    }
    return new String(result);
  }

  private static boolean constantTimeEquals(String left, String right) {
    if (left == null || right == null) return false;
    return MessageDigest.isEqual(left.getBytes(StandardCharsets.US_ASCII), right.getBytes(StandardCharsets.US_ASCII));
  }

  private static boolean same(String left, String right) {
    return left != null && left.equals(right);
  }
}
