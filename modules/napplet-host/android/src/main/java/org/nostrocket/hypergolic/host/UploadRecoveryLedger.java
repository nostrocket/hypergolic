package org.nostrocket.hypergolic.host;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Metadata-only native write-ahead state. Records never contain bodies, credentials or resumable grants. */
final class UploadRecoveryLedger {
  static final int MAX_RECORDS = 32, MAX_STORE_BYTES = 128 * 1024;
  private static final byte[] MAGIC = "HGUR0001".getBytes(StandardCharsets.US_ASCII);
  enum State { UNKNOWN, PRESENT, ABSENT, CONFIRMED, REJECTED, NOT_SENT }
  interface Store { byte[] read() throws IOException; void write(byte[] value) throws IOException; }
  record Entry(String uploadId, String identity, String publisher, String appId, String destination,
               String sha256, String mimeType, int size, State state) {
    Entry {
      if (uploadId == null || !UUID.fromString(uploadId).toString().equals(uploadId) ||
          !hex(identity) || !hex(publisher) || !hex(sha256) || !validText(appId, 1024) || appId.isEmpty() ||
          !NativeUploadAuthority.validDestination(destination) || size < 1 || size > NativeUploadAuthority.MAX_BYTES || state == null ||
          mimeType == null || !Set.of("image/png", "audio/wav", "audio/mpeg", "video/mp4", "application/pdf", "application/zip", "text/plain", "text/html").contains(mimeType)) {
        throw new IllegalArgumentException("Invalid recovery metadata");
      }
    }
    Entry withState(State next) { return new Entry(uploadId, identity, publisher, appId, destination, sha256, mimeType, size, next); }
  }
  private final Store store;
  private LinkedHashMap<String, Entry> rows;
  private boolean healthy = true;
  UploadRecoveryLedger(Store store) throws IOException {
    if (store == null) throw new IOException("Recovery store unavailable");
    this.store = store; byte[] bytes = store.read(); rows = bytes == null ? new LinkedHashMap<>() : decode(bytes);
  }
  synchronized List<Entry> list(String identity) throws IOException {
    available(); if (!hex(identity)) throw new IOException("Invalid recovery identity");
    var result = new ArrayList<Entry>();
    for (Entry row : rows.values()) if (row.identity.equals(identity)) result.add(row);
    return Collections.unmodifiableList(result);
  }
  synchronized boolean blocks(String identity, String destination, String hash) throws IOException {
    available(); if (!hex(identity) || !hex(hash) || !NativeUploadAuthority.validDestination(destination)) throw new IOException("Invalid recovery scope");
    return rows.values().stream().anyMatch(row -> row.state == State.UNKNOWN &&
      row.identity.equals(identity) && row.destination.equals(destination) && row.sha256.equals(hash));
  }
  /** Must finish durable store/readback before the caller can emit any PUT headers or body. */
  synchronized boolean start(Entry entry) throws IOException {
    available(); if (entry == null || entry.state != State.UNKNOWN || rows.containsKey(entry.uploadId) ||
      blocks(entry.identity, entry.destination, entry.sha256)) return false;
    var next = new LinkedHashMap<>(rows);
    if (next.size() == MAX_RECORDS) {
      String oldest = next.values().stream().filter(row -> row.state != State.UNKNOWN).map(Entry::uploadId).findFirst().orElse(null);
      if (oldest == null) return false; next.remove(oldest);
    }
    next.put(entry.uploadId, entry); commit(next); return true;
  }
  /** Only a captured native receipt/read operation may settle its exact unchanged record. */
  synchronized boolean settle(Entry expected, State state) throws IOException {
    available(); if (expected == null || state == null || state == State.UNKNOWN || expected.state != State.UNKNOWN ||
      !expected.equals(rows.get(expected.uploadId))) return false;
    var next = new LinkedHashMap<>(rows); next.put(expected.uploadId, expected.withState(state)); commit(next); return true;
  }
  private void available() throws IOException { if (!healthy) throw new IOException("Recovery store unavailable"); }
  private void commit(LinkedHashMap<String, Entry> next) throws IOException {
    byte[] value = encode(next);
    try {
      store.write(value.clone()); byte[] readback = store.read();
      if (readback == null || !MessageDigest.isEqual(value, readback)) throw new IOException("Recovery write not retained");
      rows = next;
    } catch (IOException | RuntimeException failed) { healthy = false; throw new IOException("Recovery store unavailable", failed); }
  }
  private static boolean hex(String value) { return value != null && value.matches("[0-9a-f]{64}"); }
  private static boolean validText(String value, int maximum) {
    return value != null && StandardCharsets.UTF_8.newEncoder().canEncode(value) && value.getBytes(StandardCharsets.UTF_8).length <= maximum;
  }
  private static byte[] digest(byte[] value) throws IOException {
    try { return MessageDigest.getInstance("SHA-256").digest(value); }
    catch (NoSuchAlgorithmException unavailable) { throw new IOException("Recovery integrity unavailable", unavailable); }
  }
  private static void text(DataOutputStream output, String value) throws IOException {
    byte[] bytes = value.getBytes(StandardCharsets.UTF_8); output.writeInt(bytes.length); output.write(bytes);
  }
  private static String text(DataInputStream input, int maximum) throws IOException {
    int length = input.readInt(); if (length < 0 || length > maximum || length > input.available()) throw new IOException("Invalid recovery field");
    byte[] bytes = new byte[length]; input.readFully(bytes);
    return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
  }
  static byte[] encode(LinkedHashMap<String, Entry> rows) throws IOException {
    if (rows.size() > MAX_RECORDS) throw new IOException("Recovery record limit");
    var bytes = new ByteArrayOutputStream(); var output = new DataOutputStream(bytes); output.write(MAGIC); output.writeInt(rows.size());
    for (var pair : rows.entrySet()) {
      Entry row = pair.getValue(); if (!pair.getKey().equals(row.uploadId)) throw new IOException("Invalid recovery key");
      text(output, row.uploadId); text(output, row.identity); text(output, row.publisher); text(output, row.appId);
      text(output, row.destination); text(output, row.sha256); text(output, row.mimeType); output.writeInt(row.size); output.writeByte(row.state.ordinal());
    }
    byte[] payload = bytes.toByteArray(); output.write(digest(payload)); output.flush();
    if (bytes.size() > MAX_STORE_BYTES) throw new IOException("Recovery byte limit"); return bytes.toByteArray();
  }
  static LinkedHashMap<String, Entry> decode(byte[] bytes) throws IOException {
    if (bytes == null || bytes.length < MAGIC.length + 4 + 32 || bytes.length > MAX_STORE_BYTES) throw new IOException("Invalid recovery store size");
    byte[] payload = Arrays.copyOf(bytes, bytes.length - 32);
    if (!MessageDigest.isEqual(digest(payload), Arrays.copyOfRange(bytes, payload.length, bytes.length))) throw new IOException("Corrupt recovery store");
    var input = new DataInputStream(new ByteArrayInputStream(payload));
    byte[] magic = new byte[MAGIC.length]; input.readFully(magic);
    if (!Arrays.equals(magic, MAGIC)) throw new IOException("Unknown recovery schema");
    int count = input.readInt(); if (count < 0 || count > MAX_RECORDS) throw new IOException("Recovery record limit");
    var rows = new LinkedHashMap<String, Entry>();
    try {
      for (int index = 0; index < count; index++) {
        String id = text(input, 36), identity = text(input, 64), publisher = text(input, 64), app = text(input, 1024);
        String server = text(input, 2048), hash = text(input, 64), mime = text(input, 32);
        int size = input.readInt(), state = input.readUnsignedByte();
        if (state >= State.values().length) throw new IOException("Unknown recovery state");
        Entry row = new Entry(id, identity, publisher, app, server, hash, mime, size, State.values()[state]);
        if (rows.put(id, row) != null) throw new IOException("Duplicate recovery record");
      }
    } catch (IllegalArgumentException invalid) { throw new IOException("Invalid recovery metadata", invalid); }
    if (input.available() != 0) throw new IOException("Trailing recovery data"); return rows;
  }
}
