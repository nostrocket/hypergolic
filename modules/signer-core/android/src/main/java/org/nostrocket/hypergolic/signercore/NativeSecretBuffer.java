package org.nostrocket.hypergolic.signercore;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

/** Native-only temporary encoding buffer. Wipes its backing storage as well as caller-owned copies. */
final class NativeSecretBuffer extends ByteArrayOutputStream implements AutoCloseable {
  NativeSecretBuffer(int size) { super(size); }
  @Override public void close() { Arrays.fill(buf, (byte)0); reset(); }
}
