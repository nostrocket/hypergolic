package org.nostrocket.hypergolic.identityowner;

/** Package-private NIP-19 display encoder; callers own and clear the returned characters. */
final class BackupNsec {
  private static final String HRP = "nsec";
  private static final char[] CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l".toCharArray();
  private static final int[] GENERATOR = {0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3};
  private static final byte[] ORDER = hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

  private BackupNsec() {}

  static char[] encode(byte[] scalar) {
    requireScalar(scalar);
    byte[] data = new byte[52];
    int[] checksumValues = new int[HRP.length() * 2 + 1 + data.length + 6];
    char[] output = new char[HRP.length() + 1 + data.length + 6];
    try {
      int accumulator = 0;
      int bits = 0;
      int index = 0;
      for (byte value : scalar) {
        accumulator = (accumulator << 8) | (value & 0xff);
        bits += 8;
        while (bits >= 5) {
          bits -= 5;
          data[index++] = (byte) ((accumulator >>> bits) & 31);
        }
      }
      if (bits != 0) data[index] = (byte) ((accumulator << (5 - bits)) & 31);

      int resultIndex = 0;
      for (int i = 0; i < HRP.length(); i++) output[resultIndex++] = HRP.charAt(i);
      output[resultIndex++] = '1';
      for (byte value : data) output[resultIndex++] = CHARSET[value & 31];
      for (int i = 0; i < HRP.length(); i++) checksumValues[i] = HRP.charAt(i) >>> 5;
      checksumValues[HRP.length()] = 0;
      for (int i = 0; i < HRP.length(); i++) checksumValues[HRP.length() + 1 + i] = HRP.charAt(i) & 31;
      for (int i = 0; i < data.length; i++) checksumValues[HRP.length() + 1 + HRP.length() + i] = data[i] & 31;
      int polymod = polymod(checksumValues) ^ 1;
      for (int i = 0; i < 6; i++) output[resultIndex++] = CHARSET[(polymod >>> (5 * (5 - i))) & 31];
      return output;
    } finally {
      java.util.Arrays.fill(data, (byte) 0);
      java.util.Arrays.fill(checksumValues, 0);
    }
  }

  static void requireScalar(byte[] scalar) {
    if (scalar == null || scalar.length != 32) throw new DeletionAuthority.Denied();
    boolean nonZero = false;
    for (byte value : scalar) if (value != 0) { nonZero = true; break; }
    if (!nonZero || compareUnsigned(scalar, ORDER) >= 0) throw new DeletionAuthority.Denied();
  }

  private static int compareUnsigned(byte[] left, byte[] right) {
    for (int i = 0; i < left.length; i++) {
      int difference = (left[i] & 0xff) - (right[i] & 0xff);
      if (difference != 0) return difference;
    }
    return 0;
  }

  private static int polymod(int[] values) {
    int checksum = 1;
    for (int value : values) {
      int top = checksum >>> 25;
      checksum = ((checksum & 0x1ffffff) << 5) ^ value;
      for (int i = 0; i < GENERATOR.length; i++) if (((top >>> i) & 1) != 0) checksum ^= GENERATOR[i];
    }
    return checksum;
  }

  private static byte[] hex(String value) {
    byte[] bytes = new byte[value.length() / 2];
    for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
    return bytes;
  }
}
