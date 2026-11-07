package org.nostrocket.hypergolic.signercore;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** No direct or reflective reference to the JNI-only HMAC callback. */
public final class TransportProof {
  public static void main(String[] args) throws Exception {
    int completed = 0;
    boolean sinkIdentity = false, serializationDenied = false;
    try (NativeSigningKey sender = new NativeSigningKey(); NativeSigningKey receiver = new NativeSigningKey()) {
      try {
        for (String text : new String[] {"x", "Fresh ephemeral JNI NIP-44 round trip"}) {
          byte[] clear = text.getBytes(StandardCharsets.UTF_8);
          byte[] payload = sender.transport(receiver.publicKey(), clear, true);
          byte[] decoded = receiver.transport(sender.publicKey(), payload, false);
          if (!Arrays.equals(clear, decoded)) throw new AssertionError("Round trip mismatch");
          Arrays.fill(clear, (byte)0); Arrays.fill(payload, (byte)0); Arrays.fill(decoded, (byte)0);
          completed++;
        }
      } catch (NativeSignerCore.Denied denied) { /* Expected no-rule control. */ }
      RuntimeException marker = new IllegalStateException("Fixture sink rejected");
      OutputStream sink = new OutputStream() {
        @Override public void write(int value) { throw marker; }
        @Override public void write(byte[] value) { throw marker; }
      };
      try { sender.writeScalar(sink); }
      catch (RuntimeException original) { sinkIdentity = original == marker; }
      Method serialize = NativeSigningKey.class.getDeclaredMethod("serialize", long.class, OutputStream.class);
      serialize.setAccessible(true);
      try { serialize.invoke(null, 0L, new ByteArrayOutputStream()); }
      catch (InvocationTargetException failed) {
        serializationDenied = failed.getCause() instanceof NativeSignerCore.Denied &&
            "Native signing request denied.".equals(failed.getCause().getMessage());
      }
    }
    System.out.println("HG_R8_TRANSPORT round-trips=" + completed + " sink-identity=" + sinkIdentity +
        " serialization-denied=" + serializationDenied);
  }
}
