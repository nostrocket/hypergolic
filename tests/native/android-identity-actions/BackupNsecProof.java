package org.nostrocket.hypergolic.identityowner;

import java.util.Arrays;

/** JVM-only proof of the package-private NIP-19 nsec display encoder. */
public final class BackupNsecProof {
  private static int assertions;

  private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Backup nsec assertion " + assertions); }
  private static byte[] scalar(int value) { byte[] bytes = new byte[32]; bytes[31] = (byte) value; return bytes; }
  private static String text(char[] value) { try { return new String(value); } finally { Arrays.fill(value, '\0'); } }
  private static void denied(byte[] value) {
    assertions++;
    try { BackupNsec.encode(value); } catch (DeletionAuthority.Denied expected) { return; }
    throw new AssertionError("Expected invalid scalar rejection at assertion " + assertions);
  }

  public static void main(String[] args) {
    check("nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl".equals(text(BackupNsec.encode(scalar(1)))));
    check("nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpqptcfk2".equals(text(BackupNsec.encode(scalar(2)))));
    check("nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqps52s3re".equals(text(BackupNsec.encode(scalar(3)))));
    byte[] unchanged = scalar(7), copy = unchanged.clone();
    check("nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrs2ewv44".equals(text(BackupNsec.encode(unchanged))));
    check(Arrays.equals(copy, unchanged));
    byte[] high = hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140");
    check("nsec1lllllllllllllllllllllllll6a2ah8x4ay2qwal6f0ge5pkg9qq7ae6fg".equals(text(BackupNsec.encode(high))));
    denied(null); denied(new byte[31]); denied(new byte[33]); denied(new byte[32]);
    byte[] order = hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    denied(order);
    byte[] above = order.clone(); above[31]++;
    denied(above);
    byte[] allOnes = new byte[32]; Arrays.fill(allOnes, (byte) 0xff);
    denied(allOnes);
    System.out.println("{\"status\":\"passed\",\"assertions\":" + assertions + ",\"scope\":\"NIP-19 nsec Bech32 encoder; no secret values logged\"}");
  }

  private static byte[] hex(String value) {
    byte[] bytes = new byte[value.length() / 2];
    for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
    return bytes;
  }
}
