package org.nostrocket.hypergolic.host;

import java.util.Arrays;
import java.util.Collections;

public final class PublishedCapabilityBindingProof {
  private static int assertions;
  private static void check(boolean condition) {
    assertions++;
    if (!condition) throw new AssertionError("Published capability binding assertion " + assertions);
  }

  private static boolean matches(String fixture, String session, String publisher, String appId, String version) {
    return PublishedCapabilityBinding.matches(fixture, session, publisher, appId, version,
        "session-A", "a".repeat(64), "test.napplet", "b".repeat(64));
  }

  public static void main(String[] args) {
    check(matches("published", "session-A", "a".repeat(64), "test.napplet", "b".repeat(64)));
    check(!matches("ux-lab", "session-A", "a".repeat(64), "test.napplet", "b".repeat(64)));
    check(!matches("published", "session-B", "a".repeat(64), "test.napplet", "b".repeat(64)));
    check(!matches("published", "session-A", "c".repeat(64), "test.napplet", "b".repeat(64)));
    check(!matches("published", "session-A", "a".repeat(64), "other.napplet", "b".repeat(64)));
    check(!matches("published", "session-A", "a".repeat(64), "test.napplet", "d".repeat(64)));
    check(!PublishedCapabilityBinding.matches("published", null, "a", "b", "c", "session-A", "a", "b", "c"));

    check(PublishedCapabilityBinding.validDomains(Collections.emptyList()));
    check(PublishedCapabilityBinding.validDomains(Arrays.asList("identity", "storage", "theme", "relay")));
    check(PublishedCapabilityBinding.validDomains(Collections.singletonList("theme")));
    check(PublishedCapabilityBinding.validDomains(Arrays.asList("outbox", "relay")));
    check(PublishedCapabilityBinding.validDomains(Collections.singletonList("outbox")));
    check(!PublishedCapabilityBinding.validDomains(Arrays.asList("outbox", "outbox", "relay")));
    check(!PublishedCapabilityBinding.validDomains(Arrays.asList("outbox", "relay", "sign")));
    check(PublishedCapabilityBinding.validDomains(Arrays.asList("resource", "upload")));
    check(PublishedCapabilityBinding.validDomains(Arrays.asList("identity", "storage", "theme", "relay", "resource", "upload")));
    check(!PublishedCapabilityBinding.validDomains(Arrays.asList("upload", "upload")));
    check(!PublishedCapabilityBinding.validDomains(Arrays.asList("theme", "theme")));
    check(!PublishedCapabilityBinding.validDomains(Collections.singletonList("unknown")));
    check(!PublishedCapabilityBinding.validDomains(Arrays.asList("identity", "storage", "theme", "relay", "extra")));
    System.out.println("{\"status\":\"passed\",\"assertions\":" + assertions + "}");
  }
}
