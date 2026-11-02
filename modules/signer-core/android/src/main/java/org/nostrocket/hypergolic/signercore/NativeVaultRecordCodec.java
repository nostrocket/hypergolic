package org.nostrocket.hypergolic.signercore;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.nostrocket.hypergolic.signercore.NativeVault.Error;
import static org.nostrocket.hypergolic.signercore.NativeVault.*;

/** Strict native binary format and owned decoded keys. Unknown or inconsistent records never become a fresh vault. */
final class NativeVaultRecordCodec {
  private static final int LEGACY_MAGIC = 0x48475632;
  private static final int REMOTE_MAGIC = 0x48475633;
  private static final int MAGIC = 0x48475634;
  static final class Record implements AutoCloseable {
    NativeSigningKey key;
    NativeRemoteBinding remote;
    NativeAndroidSignerBinding androidSigner;
    final String pubkey;
    final long addedAt;
    final int origin;
    int method;

    Record(NativeSigningKey key, long addedAt, int origin) {
      this(key.publicKey(), key, null, addedAt, origin, LOCAL);
    }
    Record(String pubkey, NativeSigningKey key, NativeRemoteBinding remote, long addedAt, int origin, int method) {
      this.pubkey = pubkey;
      this.key = key;
      this.remote = remote;
      this.addedAt = addedAt;
      this.origin = origin;
      this.method = method;
    }
    @Override public void close() {
      if (key != null) key.close();
      if (remote != null) remote.close();
    }
  }
  static final class State implements AutoCloseable {
    String id, selected;
    long revision;
    byte[] persistedHash;
    final List<Record> records = new ArrayList<>();
    @Override public void close() {
      for (Record value : records) value.close();
      records.clear();
    }
  }
  static byte[] hash(byte[] value) {
    try { return MessageDigest.getInstance("SHA-256").digest(value); }
    catch (Exception failure) { throw new Error("STORAGE_FAILURE"); }
  }
  static Record record(State state, String pubkey) {
    return state.records.stream().filter(value -> value.pubkey.equals(pubkey)).findFirst()
      .orElseThrow(() -> new Error("NOT_FOUND"));
  }
  static byte[] encode(State state) {
    try (NativeSecretBuffer bytes = new NativeSecretBuffer(1024); DataOutputStream output = new DataOutputStream(bytes)) {
      output.writeInt(MAGIC);
      output.writeLong(state.revision);
      output.write(hex(state.id));
      output.write(hex(state.selected));
      output.writeByte(state.records.size());
      for (Record value : state.records) {
        output.write(hex(value.pubkey));
        output.writeLong(value.addedAt);
        output.writeByte(value.origin);
        output.writeByte(value.method);
        output.writeBoolean(value.key != null);
        if (value.key != null) value.key.writeScalar(output);
        output.writeBoolean(value.remote != null);
        if (value.remote != null) {
          value.remote.client.writeScalar(output);
          output.write(hex(value.remote.peer));
          output.writeByte(value.remote.relays.size());
          for (String relay : value.remote.relays) output.writeUTF(relay);
        }
        output.writeBoolean(value.androidSigner != null);
        if (value.androidSigner != null) {
          output.writeUTF(value.androidSigner.packageName);
          output.writeByte(value.androidSigner.certificateSha256s.size());
          for (String certificate : value.androidSigner.certificateSha256s) output.write(hex(certificate));
        }
      }
      output.flush();
      byte[] result = bytes.toByteArray();
      if (result.length > NativeVaultFile.MAX_CLEAR_BYTES) {
        Arrays.fill(result, (byte)0);
        throw new Error("LIMIT_REACHED");
      }
      return result;
    } catch (Error failure) { throw failure; }
    catch (Exception failure) { throw new Error("STORAGE_FAILURE"); }
  }
  private static NativeSigningKey readKey(DataInputStream input, byte[] scalar) throws Exception {
    input.readFully(scalar);
    try { return NativeSigningKey.importScalar(scalar); }
    finally { Arrays.fill(scalar, (byte)0); }
  }
  private static boolean readBoolean(DataInputStream input) throws Exception {
    int value = input.readUnsignedByte();
    if (value > 1) throw new Exception();
    return value == 1;
  }
  static State decode(byte[] bytes) {
    State result = new State();
    byte[] scalar = new byte[32];
    NativeSigningKey local = null, client = null;
    NativeRemoteBinding remote = null;
    try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
      int magic = input.readInt();
      if (magic != MAGIC && magic != REMOTE_MAGIC && magic != LEGACY_MAGIC) throw new Exception();
      result.revision = input.readLong();
      if (result.revision < 1 || result.revision > MAX_REVISION) throw new Exception();
      byte[] id = new byte[16], selected = new byte[32];
      input.readFully(id);
      input.readFully(selected);
      result.id = NativeEvent.hex(id);
      result.selected = NativeEvent.hex(selected);
      int count = input.readUnsignedByte();
      if (count < 1 || count > MAX_IDENTITIES) throw new Exception();
      for (int index = 0; index < count; index++) {
        byte[] publicKey = new byte[32];
        input.readFully(publicKey);
        String expected = NativeEvent.hex(publicKey);
        long added = input.readLong();
        int origin = input.readUnsignedByte();
        if (!NativeSigningKey.validPublicKey(expected) || added < 0 || added > MAX_REVISION || origin > 2 ||
            result.records.stream().anyMatch(value -> value.pubkey.equals(expected))) throw new Exception();
        int method = magic == LEGACY_MAGIC ? LOCAL : input.readUnsignedByte();
        if (magic == LEGACY_MAGIC || readBoolean(input)) {
          local = readKey(input, scalar);
          if (!local.publicKey().equals(expected)) throw new Exception();
        }
        if (magic != LEGACY_MAGIC && readBoolean(input)) {
          client = readKey(input, scalar);
          byte[] peer = new byte[32];
          input.readFully(peer);
          int relayCount = input.readUnsignedByte();
          if (relayCount < 1 || relayCount > 3) throw new Exception();
          List<String> relays = new ArrayList<>();
          for (int relay = 0; relay < relayCount; relay++) relays.add(input.readUTF());
          remote = new NativeRemoteBinding(client, NativeEvent.hex(peer), relays);
          client = null;
        }
        NativeAndroidSignerBinding androidSigner = null;
        if (magic == MAGIC && readBoolean(input)) {
          String packageName = input.readUTF();
          int certificateCount = input.readUnsignedByte();
          if (certificateCount < 1 || certificateCount > 16) throw new Exception();
          List<String> certificates = new ArrayList<>();
          for (int certificate = 0; certificate < certificateCount; certificate++) {
            byte[] digest = new byte[32]; input.readFully(digest); certificates.add(NativeEvent.hex(digest));
          }
          androidSigner = new NativeAndroidSignerBinding(packageName, certificates);
        }
        if (method < NO_METHOD || method > (magic == MAGIC ? NIP55 : NIP46) || method == LOCAL && local == null || method == NIP46 && remote == null || method == NIP55 && androidSigner == null) {
          throw new Exception();
        }
        Record record = new Record(expected, local, remote, added, origin, method);
        record.androidSigner = androidSigner;
        result.records.add(record);
        local = null;
        remote = null;
      }
      if (input.available() != 0 || result.records.stream().noneMatch(value -> value.pubkey.equals(result.selected))) throw new Exception();
      result.persistedHash = hash(bytes);
      return result;
    } catch (Exception failure) {
      if (local != null) local.close();
      if (client != null) client.close();
      if (remote != null) remote.close();
      result.close();
      throw new Error("CORRUPT_METADATA");
    } finally { Arrays.fill(scalar, (byte)0); }
  }
}
