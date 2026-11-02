package org.nostrocket.hypergolic.signercore;

import java.util.Arrays;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Platform HMAC callback for the reviewed native NIP44 implementation. Never registered with Expo. */
final class NativeTransportCrypto {
  private NativeTransportCrypto() {}
  static byte[] hmac(byte[] key, byte[] message) {
    try {
      if (key == null || message == null || (key.length != 8 && key.length != 32)) return null;
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(key, "HmacSHA256"));
      return mac.doFinal(message);
    } catch (Exception failure) { return null; }
    finally {
      if (key != null) Arrays.fill(key, (byte)0);
      if (message != null) Arrays.fill(message, (byte)0);
    }
  }
}
