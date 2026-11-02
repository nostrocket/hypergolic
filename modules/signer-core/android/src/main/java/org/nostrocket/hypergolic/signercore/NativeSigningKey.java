package org.nostrocket.hypergolic.signercore;

/** No bridge export: native C owns the scalar and obtains OS entropy itself. */
final class NativeSigningKey implements AutoCloseable {
  static { System.loadLibrary("hypergolic_signer_jni"); }
  private long handle;
  NativeSigningKey() {
    handle = generate();
    if (handle == 0) throw new NativeSignerCore.Denied();
  }
  private NativeSigningKey(long value) {
    handle = value;
    if (handle == 0) throw new NativeSignerCore.Denied();
  }
  static NativeSigningKey importScalar(byte[] scalar) {
    if (scalar == null || scalar.length != 32) throw new NativeSignerCore.Denied();
    return new NativeSigningKey(restore(scalar));
  }
  /** Native persistence/display sink only. There is no returned raw-secret getter or Expo export. */
  synchronized void writeScalar(java.io.OutputStream sink) {
    if (handle == 0 || sink == null) throw new NativeSignerCore.Denied();
    serialize(handle, sink);
  }
  synchronized String publicKey() {
    if (handle == 0) throw new NativeSignerCore.Denied();
    byte[] result = publicKey(handle);
    if (result == null || result.length != 32) throw new NativeSignerCore.Denied();
    return NativeEvent.hex(result);
  }
  synchronized String sign(byte[] digest) {
    if (handle == 0 || digest.length != 32) throw new NativeSignerCore.Denied();
    byte[] result = sign(handle, digest);
    if (result == null || result.length != 64) throw new NativeSignerCore.Denied();
    return NativeEvent.hex(result);
  }
  synchronized NativeSigningKey copy() {
    byte[] scalar = null;
    try (NativeSecretBuffer bytes = new NativeSecretBuffer(32)) {
      writeScalar(bytes);
      scalar = bytes.toByteArray();
      return importScalar(scalar);
    } finally { if (scalar != null) java.util.Arrays.fill(scalar, (byte)0); }
  }
  private static byte[] decodeHex(String value) {
    byte[] bytes = new byte[value.length() / 2];
    for (int index = 0; index < bytes.length; index++) {
      bytes[index] = (byte)((Character.digit(value.charAt(index * 2), 16) << 4) | Character.digit(value.charAt(index * 2 + 1), 16));
    }
    return bytes;
  }
  static boolean validPublicKey(String value) {
    return value != null && value.matches("[0-9a-f]{64}") && validPoint(decodeHex(value));
  }
  static boolean verify(String pubkey, byte[] digest, String signature) {
    return validPublicKey(pubkey) && digest != null && digest.length == 32 && signature != null && signature.matches("[0-9a-f]{128}")
      && verifyDigest(decodeHex(pubkey), digest, decodeHex(signature));
  }
  /** Borrowed plaintext stays native; caller owns and wipes the returned bytes. */
  synchronized byte[] transport(String peer, byte[] input, boolean encrypting) {
    if (handle == 0 || !validPublicKey(peer)) throw new NativeSignerCore.Denied();
    try (NativeSecretBuffer sink = new NativeSecretBuffer(128)) {
      int status = transportCrypt(handle, decodeHex(peer), input, encrypting, sink);
      if (status != 1) throw new NativeSignerCore.Denied();
      return sink.toByteArray();
    }
  }
  @Override public synchronized void close() {
    if (handle != 0) { destroy(handle); handle = 0; }
  }
  private static native boolean validPoint(byte[] pubkey);
  private static native boolean verifyDigest(byte[] pubkey, byte[] digest, byte[] signature);
  private static native int transportCrypt(long handle, byte[] peer, byte[] input, boolean encrypting, java.io.OutputStream sink);
  private static native long generate();
  private static native byte[] publicKey(long handle);
  private static native byte[] sign(long handle, byte[] digest);
  private static native long restore(byte[] scalar);
  private static native void serialize(long handle, java.io.OutputStream sink);
  private static native void destroy(long handle);
}
