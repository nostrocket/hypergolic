package org.nostrocket.hypergolic.host;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

public final class FrameVectorsJava {
  private static int assertions;
  public static void main(String[] args) throws Exception {
    List<String> lines = Files.readAllLines(Paths.get(args[0]));
    for (String line : lines) {
      if (line.isEmpty() || line.startsWith("#")) continue;
      String[] fields = line.split("\\|", -1);
      PublishedRelayWebSocketFrames parser = new PublishedRelayWebSocketFrames();
      List<PublishedRelayWebSocketFrames.Event> events = new ArrayList<>();
      byte[] bytes = fromHex(fields[1]);
      int chunk = fields[0].equals("one-byte-incremental") ? 1 : 3;
      for (int i = 0; i < bytes.length; i += chunk) {
        int end = Math.min(bytes.length, i + chunk);
        byte[] part = new byte[end - i];
        System.arraycopy(bytes, i, part, 0, part.length);
        events.addAll(parser.feed(part));
      }
      equal(fields[2], normalized(events), fields[0]);
    }
    exactMessageBoundary();
    overMessageBoundary();
    rawFrameBoundary();
    oversizedRead();
    System.out.println("Java shared vectors and bounds: " + assertions + " assertions passed");
  }

  private static void exactMessageBoundary() {
    PublishedRelayWebSocketFrames parser = new PublishedRelayWebSocketFrames();
    List<PublishedRelayWebSocketFrames.Event> events = new ArrayList<>();
    events.addAll(feed(parser, firstFragment()));
    events.addAll(parser.feed(new byte[] {(byte) 0x80, 10, 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b'}));
    check(events.size() == 1 && "text".equals(events.get(0).type) && events.get(0).text.length() == 66_560,
      "exact 66560-byte fragmented UTF-8 text accepted");
  }

  private static void overMessageBoundary() {
    PublishedRelayWebSocketFrames parser = new PublishedRelayWebSocketFrames();
    List<PublishedRelayWebSocketFrames.Event> events = new ArrayList<>();
    events.addAll(feed(parser, firstFragment()));
    events.addAll(parser.feed(new byte[] {(byte) 0x80, 11, 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b'}));
    equal("ERROR:message-too-large", normalized(events), "fragmented message overflow");
  }

  private static void rawFrameBoundary() {
    PublishedRelayWebSocketFrames parser = new PublishedRelayWebSocketFrames();
    byte[] header = new byte[] {(byte) 0x81, 127, 0, 0, 0, 0, 0, 1, 3, (byte) 0xf7};
    equal("ERROR:frame-too-large", normalized(parser.feed(header)), "66,561-byte raw frame rejected from header alone");
  }

  private static byte[] firstFragment() {
    byte[] bytes = new byte[10 + 66_550];
    bytes[0] = 0x01; bytes[1] = 127;
    bytes[7] = 0x01; bytes[8] = 0x03; bytes[9] = (byte) 0xf6;
    for (int i = 10; i < bytes.length; i++) bytes[i] = 'a';
    return bytes;
  }

  private static List<PublishedRelayWebSocketFrames.Event> feed(PublishedRelayWebSocketFrames parser, byte[] bytes) {
    List<PublishedRelayWebSocketFrames.Event> events = new ArrayList<>();
    for (int i = 0; i < bytes.length; i += PublishedRelayWebSocketFrames.MAX_READ) {
      int end = Math.min(bytes.length, i + PublishedRelayWebSocketFrames.MAX_READ);
      byte[] part = new byte[end - i];
      System.arraycopy(bytes, i, part, 0, part.length);
      events.addAll(parser.feed(part));
    }
    return events;
  }

  private static void oversizedRead() {
    PublishedRelayWebSocketFrames parser = new PublishedRelayWebSocketFrames();
    equal("ERROR:read-too-large", normalized(parser.feed(new byte[8_193])), "read chunk limit");
  }

  private static byte[] fromHex(String s) {
    byte[] r = new byte[s.length() / 2];
    for (int i = 0; i < r.length; i++) r[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
    return r;
  }
  private static String normalized(List<PublishedRelayWebSocketFrames.Event> events) {
    StringBuilder b = new StringBuilder();
    for (PublishedRelayWebSocketFrames.Event e : events) { if (b.length() > 0) b.append(';'); b.append(e.normalized()); }
    return b.toString();
  }
  private static void equal(String expected, String actual, String name) {
    check(expected.equals(actual), name + " expected=" + expected + " actual=" + actual);
  }
  private static void check(boolean ok, String name) { assertions++; if (!ok) throw new AssertionError(name); }
}
