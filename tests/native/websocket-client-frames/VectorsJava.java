package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Base64;

public final class VectorsJava {
  private static int assertions;
  public static void main(String[] args) throws Exception {
    for (String line : Files.readAllLines(Paths.get(args[0]))) {
      if (line.isEmpty() || line.startsWith("#")) continue;
      String[] f = line.split("\\|", -1);
      byte[] input = Base64.getDecoder().decode(f[1]);
      byte[] mask = hex(f[2]);
      byte[] actual;
      switch (f[0]) {
        case "text-req": case "empty-text":
          actual = PublishedRelayWebSocketClientFrames.textReq(new String(input, StandardCharsets.UTF_8), mask); break;
        case "pong": actual = PublishedRelayWebSocketClientFrames.pong(input, mask); break;
        case "close":
          String[] close = new String(input, StandardCharsets.UTF_8).split("\\|", 2);
          actual = PublishedRelayWebSocketClientFrames.close(Integer.parseInt(close[0]), close[1], mask); break;
        default: throw new AssertionError("unknown vector " + f[0]);
      }
      byte[] expected = Base64.getDecoder().decode(f[3]);
      equal(f[0], expected, actual);
    }
    rejects("short-mask", () -> PublishedRelayWebSocketClientFrames.pong(new byte[0], new byte[3]));
    rejects("long-pong", () -> PublishedRelayWebSocketClientFrames.pong(new byte[126], new byte[4]));
    rejects("long-close-reason", () -> PublishedRelayWebSocketClientFrames.close(1000, "x".repeat(124), new byte[4]));
    rejects("reserved-close-code", () -> PublishedRelayWebSocketClientFrames.close(1005, "", new byte[4]));
    rejects("oversized-text", () -> PublishedRelayWebSocketClientFrames.textReq("x".repeat(8193), new byte[4]));
    rejects("invalid-utf16", () -> PublishedRelayWebSocketClientFrames.textReq("\ud800", new byte[4]));
    byte[] extended = PublishedRelayWebSocketClientFrames.textReq("a".repeat(126), new byte[] {1, 2, 3, 4});
    if (extended.length != 134 || (extended[1] & 255) != 0xfe || extended[2] != 0 || extended[3] != 126)
      throw new AssertionError("extended-length-header");
    for (int i = 0; i < 126; i++) if ((byte) (extended[8 + i] ^ extended[4 + (i & 3)]) != (byte) 'a')
      throw new AssertionError("extended-length-payload");
    assertions += 2;
    byte[] random = PublishedRelayWebSocketClientFrames.pong(new byte[] {1, 2, 3});
    if ((random[1] & 0x80) == 0 || random.length != 9) throw new AssertionError("random-mask-frame-shape");
    byte[] key = {random[2], random[3], random[4], random[5]};
    for (int i = 0; i < 3; i++) if ((byte) (random[6 + i] ^ key[i]) != i + 1) throw new AssertionError("random-mask-payload");
    assertions += 2;
    System.out.println("Java RFC6455 client frame vectors and limits: " + assertions + " passed");
  }

  private interface Action { void run() throws Exception; }
  private static void rejects(String name, Action action) throws Exception {
    try { action.run(); throw new AssertionError(name + " accepted"); }
    catch (IllegalArgumentException expected) { assertions++; }
  }
  private static byte[] hex(String value) {
    byte[] result = new byte[value.length() / 2];
    for (int i = 0; i < result.length; i++) result[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
    return result;
  }
  private static void equal(String name, byte[] expected, byte[] actual) {
    if (!java.util.Arrays.equals(expected, actual)) throw new AssertionError(name + " frame mismatch");
    assertions++;
  }
}
