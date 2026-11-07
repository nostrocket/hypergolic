package org.nostrocket.hypergolic.host;

import java.io.IOException;

/** Focused strict NIP-01 request and response-envelope proof. */
public final class PublishedRelayResponseClassifierProof {
  private static int checks;
  public static void main(String[] args) throws Exception {
    PublishedRelayResponseClassifier.validateRequest("[\"REQ\",\"sub-1\",{\"kinds\":[31990]},{}]", "sub-1");
    rejectsRequest("[\"REQ\",\"wrong\",{}]", "sub-1");
    rejectsRequest("[\"EVENT\",\"sub-1\",{}]", "sub-1");
    rejectsRequest("[\"REQ\",\"sub-1\",[]]", "sub-1");
    rejectsRequest("[\"REQ\",\"sub-1\",{},]");
    rejectsRequest("[\"REQ\",\"sub-1\",{}] trailing", "sub-1");
    rejectsRequest("[\"REQ\",\"sub-1\",{}]", "bad id");

    PublishedRelayResponseClassifier classifier = new PublishedRelayResponseClassifier("sub-1");
    equal(PublishedRelayWssQuery.TextKind.EVENT, classifier.classify("[\"EVENT\",\"sub-1\",{\"id\":\"x\",\"tags\":[[\"t\",1]]}]"));
    equal(PublishedRelayWssQuery.TextKind.EOSE, classifier.classify("[\"EOSE\",\"sub-1\"]"));
    equal(PublishedRelayWssQuery.TextKind.OTHER, classifier.classify("[\"NOTICE\",\"relay ready\"]"));
    equal(PublishedRelayWssQuery.TextKind.OTHER, classifier.classify("[\"NOTICE\",\"💥\"]"));
    rejectsResponse(classifier, "[\"EVENT\",\"wrong\",{}]");
    rejectsResponse(classifier, "[\"EOSE\",\"wrong\"]");
    rejectsResponse(classifier, "[\"EVENT\",\"sub-1\",[]]");
    rejectsResponse(classifier, "[\"EVENT\",\"sub-1\",{} , false]");
    rejectsResponse(classifier, "[\"EOSE\",\"sub-1\",null]");
    rejectsResponse(classifier, "[\"NOTICE\",\"x\",null]");
    rejectsResponse(classifier, "[\"NOTICE\",\"" + repeat('x', 257) + "\"]");
    equal(PublishedRelayWssQuery.TextKind.OTHER, classifier.classify("[\"AUTH\",\"\"]"));
    equal(PublishedRelayWssQuery.TextKind.OTHER, classifier.classify("[\"AUTH\",\"rotated\"]"));
    rejectsResponse(classifier, "[\"AUTH\"]");
    rejectsResponse(classifier, "[\"AUTH\",null]");
    rejectsResponse(classifier, "[\"AUTH\",{}]");
    rejectsResponse(classifier, "[\"AUTH\",\"challenge\",\"extra\"]");
    rejectsResponse(classifier, "[\"AUTH\",\"" + repeat('x', PublishedRelayWebSocketFrames.MAX_BYTES) + "\"]");
    rejectsResponse(classifier, "[\"CLOSED\",\"sub-1\",\"policy\"]");
    rejectsResponse(classifier, "[\"CLOSED\",\"wrong\",\"policy\"]");
    rejectsResponse(classifier, "[\"UNKNOWN\",\"sub-1\"]");
    rejectsResponse(classifier, "[\"EVENT\",\"sub-1\",{\"id\":01}]");
    rejectsResponse(classifier, "[\"EVENT\",\"sub-1\",{\"id\":\"x\",}]");
    rejectsResponse(classifier, "[\"EVENT\",\"sub-1\",{\"s\":\"\\uD800\"}]");
    responseProfiles(classifier);
    System.out.println("PublishedRelayResponseClassifierProof: " + checks + " checks passed");
  }
  private static void responseProfiles(PublishedRelayResponseClassifier standard) throws Exception {
    var wide = new PublishedRelayResponseClassifier("sub-1", PublishedRelayResponseClassifier.ResponseProfile.OUTBOX);
    String event = "[\"EVENT\",\"sub-1\",{}]", eose = "[\"EOSE\",\"sub-1\"]", notice = "[\"NOTICE\",\"test\"]";
    var raw = new PublishedRelayResponseClassifier.ResponseCollector(standard);
    for (int i = 0; i < 32; i++) raw.accept(event);
    rejectsBound(raw, event);
    var outbox = new PublishedRelayResponseClassifier.ResponseCollector(wide);
    for (int i = 0; i < 200; i++) outbox.accept(event);
    for (int i = 0; i < 55; i++) outbox.accept(notice);
    equal(true, outbox.accept(eose));
    equal(256, outbox.result().size());
    var events = new PublishedRelayResponseClassifier.ResponseCollector(wide);
    for (int i = 0; i < 200; i++) events.accept(event);
    rejectsBound(events, event);
    var frames = new PublishedRelayResponseClassifier.ResponseCollector(wide);
    for (int i = 0; i < 256; i++) frames.accept(notice);
    rejectsBound(frames, eose);
    String large = "[\"AUTH\",\"" + repeat('x', 64 * 1024 - 11) + "\"]";
    for (var policy : java.util.List.of(standard, wide)) {
      var bytes = new PublishedRelayResponseClassifier.ResponseCollector(policy);
      for (int i = 0; i < 32; i++) bytes.accept(large);
      rejectsBound(bytes, eose);
    }
  }
  private static void rejectsBound(PublishedRelayResponseClassifier.ResponseCollector collector, String text) throws Exception {
    try { collector.accept(text); throw new AssertionError("Response bound was exceeded"); }
    catch (IOException expected) { checks++; }
  }
  private static void rejectsRequest(String text, String id) throws Exception {
    try { PublishedRelayResponseClassifier.validateRequest(text, id); throw new AssertionError("REQ accepted"); }
    catch (IOException expected) { checks++; }
  }
  private static void rejectsRequest(String text) throws Exception { rejectsRequest(text, "sub-1"); }
  private static void rejectsResponse(PublishedRelayResponseClassifier classifier, String text) throws Exception {
    try { classifier.classify(text); throw new AssertionError("Response accepted: " + text); }
    catch (IOException expected) { checks++; }
  }
  private static String repeat(char c, int n) { char[] chars = new char[n]; java.util.Arrays.fill(chars, c); return new String(chars); }
  private static void equal(Object expected, Object actual) {
    if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
    checks++;
  }
}
