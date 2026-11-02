package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.net.InetAddress;
import java.util.List;

/** Host-JVM proof for bounded WSS URL, DNS-result, and response-session policy. */
public final class PublishedRelayWssQueryProof {
  private static int checks;

  public static void main(String[] args) throws Exception {
    urls();
    dns();
    collector();
    System.out.println("PublishedRelayWssQueryProof: " + checks + " checks passed");
  }

  private static void urls() throws Exception {
    assertUrl("wss://relay.example.org", "relay.example.org", 443, "/");
    assertUrl("wss://relay.example.org:8443/nostr", "relay.example.org", 8443, "/nostr");
    rejectUrl(null);
    rejectUrl("https://relay.example.org");
    rejectUrl("ws://relay.example.org");
    rejectUrl("wss://user@relay.example.org");
    rejectUrl("wss://user:pass@relay.example.org");
    rejectUrl("wss://relay.example.org?token=secret");
    rejectUrl("wss://relay.example.org/#fragment");
    rejectUrl("wss://relay.example.org:0");
    rejectUrl("wss://127.0.0.1");
    rejectUrl("wss://2130706433");
    rejectUrl("wss://0x7f.1");
    rejectUrl("wss://relay.123");
    rejectUrl("wss://relay.localdomain");
    rejectUrl("wss://relay.home.arpa");
    rejectUrl("wss://relay.local");
    rejectUrl("wss://relay.example.org/");
    rejectUrl("wss://relay.example.org/a/../b");
    rejectUrl("wss://relay.example.org/%0dInjected");
    rejectUrl("wss://relay.example.org\\@evil.example");
    rejectUrl("wss://relay.example.org\r\nHost: evil");
    StringBuilder tooLong = new StringBuilder("wss://relay.example.org/");
    while (tooLong.length() <= 2_048) tooLong.append('a');
    rejectUrl(tooLong.toString());
  }

  private static void assertUrl(String raw, String host, int port, String path) throws Exception {
    PublishedRelayWssQuery.RelayUrl parsed = PublishedRelayWssQuery.parseUrl(raw);
    equal(host, parsed.host);
    equal(port, parsed.port);
    equal(path, parsed.path);
  }

  private static void rejectUrl(String raw) throws Exception {
    try { PublishedRelayWssQuery.parseUrl(raw); throw new AssertionError("URL accepted: " + raw); }
    catch (IOException expected) { checks++; }
  }

  private static void dns() throws Exception {
    PublishedHttpsTransport.AddressPolicy policy = new PublishedHttpsTransport.AddressPolicy() {
      @Override public boolean isAllowedHost(String hostname) { return "relay.example.org".equals(hostname); }
      @Override public boolean isAllowedAddress(InetAddress address) {
        return PublicAddressPolicy.accepts(address.getAddress());
      }
    };
    InetAddress[] allPublic = new InetAddress[] {
        InetAddress.getByAddress(new byte[] {(byte) 8, 8, 8, 8}),
        InetAddress.getByAddress(new byte[] {(byte) 1, 1, 1, 1})
    };
    InetAddress[] accepted = PublishedRelayWssQuery.checkedAddresses(allPublic, policy);
    equal(2, accepted.length);
    accepted[0] = InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
    equal(8, allPublic[0].getAddress()[0] & 0xff); // Defensive array copy.
    rejectAddresses(new InetAddress[0], policy);
    rejectAddresses(null, policy);
    rejectAddresses(new InetAddress[] {allPublic[0], InetAddress.getByAddress(new byte[] {10, 0, 0, 1})}, policy);
    checks++;
  }

  private static void rejectAddresses(InetAddress[] addresses, PublishedHttpsTransport.AddressPolicy policy)
      throws Exception {
    try { PublishedRelayWssQuery.checkedAddresses(addresses, policy); throw new AssertionError("DNS set accepted"); }
    catch (IOException expected) { checks++; }
  }

  private static void collector() throws Exception {
    PublishedRelayResponseClassifier.ResponseCollector collector = new PublishedRelayResponseClassifier.ResponseCollector(
        text -> text.startsWith("[\"EVENT\"") ? PublishedRelayWssQuery.TextKind.EVENT :
            text.equals("[\"EOSE\",\"test-sub\"]") ? PublishedRelayWssQuery.TextKind.EOSE : PublishedRelayWssQuery.TextKind.OTHER);
    check(!collector.accept("[\"EVENT\",\"test-sub\",{}]"));
    check(collector.accept("[\"EOSE\",\"test-sub\"]"));
    check(collector.complete());
    equal(2, collector.result().size());
    try { collector.accept("late"); throw new AssertionError("Post-EOSE frame accepted"); }
    catch (IOException expected) { checks++; }

    byte[] eoseFrame = serverText("eose");
    byte[] mixedRead = java.util.Arrays.copyOf(eoseFrame, eoseFrame.length + 2);
    mixedRead[eoseFrame.length] = (byte) 0x82; // Unsupported binary opcode after the EOSE text.
    mixedRead[eoseFrame.length + 1] = 0;
    PublishedRelayWebSocketFrames decoder = new PublishedRelayWebSocketFrames();
    List<PublishedRelayWebSocketFrames.Event> batch = decoder.feed(mixedRead);
    PublishedRelayResponseClassifier.ResponseCollector batchCollector = new PublishedRelayResponseClassifier.ResponseCollector(
        text -> PublishedRelayWssQuery.TextKind.EOSE);
    try { batchCollector.preflight(batch); throw new AssertionError("Malformed trailing frame was not preflighted"); }
    catch (IOException expected) { checks++; }
    check(!batchCollector.complete());

    PublishedRelayResponseClassifier.ResponseCollector aggregate = new PublishedRelayResponseClassifier.ResponseCollector(text -> PublishedRelayWssQuery.TextKind.OTHER);
    String payload = repeat('x', 66_000);
    for (int i = 0; i < 31; i++) check(!aggregate.accept(payload));
    try { aggregate.accept(payload); throw new AssertionError("Aggregate response over limit accepted"); }
    catch (IOException expected) { checks++; }

    PublishedRelayResponseClassifier.ResponseCollector count = new PublishedRelayResponseClassifier.ResponseCollector(text -> PublishedRelayWssQuery.TextKind.EVENT);
    for (int i = 0; i < PublishedRelayWssQuery.MAX_EVENTS; i++) check(!count.accept("x"));
    try { count.accept("x"); throw new AssertionError("Text count over limit accepted"); }
    catch (IOException expected) { checks++; }

    PublishedRelayResponseClassifier.ResponseCollector eventAndEose = new PublishedRelayResponseClassifier.ResponseCollector(
        text -> text.equals("eose") ? PublishedRelayWssQuery.TextKind.EOSE : PublishedRelayWssQuery.TextKind.EVENT);
    for (int i = 0; i < PublishedRelayWssQuery.MAX_EVENTS; i++) check(!eventAndEose.accept("event"));
    check(eventAndEose.accept("eose"));

    PublishedRelayResponseClassifier.ResponseCollector perFrame = new PublishedRelayResponseClassifier.ResponseCollector(text -> PublishedRelayWssQuery.TextKind.OTHER);
    try { perFrame.accept(repeat('x', PublishedRelayWebSocketFrames.MAX_BYTES + 1)); throw new AssertionError("Oversized text accepted"); }
    catch (IOException expected) { checks++; }
    expectUnmodifiable(collector.result());
  }

  private static void expectUnmodifiable(List<String> result) {
    try { result.add("mutation"); throw new AssertionError("Result was mutable"); }
    catch (UnsupportedOperationException expected) { checks++; }
  }
  private static String repeat(char character, int count) {
    char[] value = new char[count];
    java.util.Arrays.fill(value, character);
    return new String(value);
  }
  private static byte[] serverText(String text) {
    byte[] payload = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    if (payload.length > 125) throw new AssertionError("Test payload too long");
    byte[] frame = new byte[payload.length + 2];
    frame[0] = (byte) 0x81;
    frame[1] = (byte) payload.length;
    System.arraycopy(payload, 0, frame, 2, payload.length);
    return frame;
  }
  private static void check(boolean value) { if (!value) throw new AssertionError("Expected true"); checks++; }
  private static void equal(Object expected, Object actual) {
    if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
    checks++;
  }
}
