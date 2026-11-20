package org.nostrocket.hypergolic.signercore;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

/** Clears each owned backing array. Callers must clear their own copies. */
final class NativeSecretBuffer extends ByteArrayOutputStream implements AutoCloseable {
  NativeSecretBuffer(int size) { super(size); }
  @Override public synchronized void write(int value) {
    byte[] previous = buf;
    super.write(value);
    if (previous != buf) Arrays.fill(previous, (byte) 0);
  }

  @Override public synchronized void write(byte[] bytes, int offset, int length) {
    byte[] previous = buf;
    super.write(bytes, offset, length);
    if (previous != buf) Arrays.fill(previous, (byte) 0);
  }

  @Override public synchronized void close() { Arrays.fill(buf, (byte)0); reset(); }
}
