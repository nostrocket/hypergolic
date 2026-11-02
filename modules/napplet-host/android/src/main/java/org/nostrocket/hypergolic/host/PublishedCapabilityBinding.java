package org.nostrocket.hypergolic.host;

import java.util.Collection;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/** Small host-side binding rules shared by the Android parser and its JVM proof. */
final class PublishedCapabilityBinding {
  private static final Set<String> DOMAINS = Collections.unmodifiableSet(
      new HashSet<>(Arrays.asList("identity", "storage", "theme", "relay", "resource", "upload", "link", "intent", "inc", "notify", "config", "outbox")));

  private PublishedCapabilityBinding() { }

  static boolean validDomains(Collection<String> domains) {
    return domains != null && domains.size() <= DOMAINS.size() &&
        new HashSet<>(domains).size() == domains.size() && DOMAINS.containsAll(domains);
  }

  static boolean matches(String fixture, String configSession, String configPublisher,
      String configAppId, String configVersion, String claimSession, String claimPublisher,
      String claimAppId, String claimVersion) {
    return "published".equals(fixture) && equal(configSession, claimSession) &&
        equal(configPublisher, claimPublisher) && equal(configAppId, claimAppId) &&
        equal(configVersion, claimVersion);
  }

  private static boolean equal(String left, String right) {
    return left != null && right != null && left.equals(right);
  }
}
