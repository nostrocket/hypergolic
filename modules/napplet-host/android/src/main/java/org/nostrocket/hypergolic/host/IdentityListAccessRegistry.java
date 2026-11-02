package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** Trusted RN policy mirror; final delivery checks run against this native revocation epoch. */
public final class IdentityListAccessRegistry {
  public static final IdentityListAccessRegistry INSTANCE = new IdentityListAccessRegistry();
  public static final class Owner {
    public final String user, publisher, appId;
    public Owner(String user, String publisher, String appId) {
      if (user == null || publisher == null || !user.matches("[0-9a-f]{64}") || !publisher.matches("[0-9a-f]{64}") || appId == null || appId.isEmpty()
          || appId.getBytes(StandardCharsets.UTF_8).length > 1024 || !new String(appId.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8).equals(appId)) throw new IllegalArgumentException("Invalid identity access owner");
      this.user = user; this.publisher = publisher; this.appId = appId;
    }
    @Override public boolean equals(Object other) {if (!(other instanceof Owner)) return false; Owner value = (Owner)other; return user.equals(value.user) && publisher.equals(value.publisher) && appId.equals(value.appId);}
    @Override public int hashCode() {return Objects.hash(user, publisher, appId);}
  }
  private Set<Owner> allowed = new HashSet<>();
  private long epoch = 0;
  public synchronized long capture() {return epoch;}
  public synchronized boolean permits(Owner owner, long capturedEpoch) {return capturedEpoch == epoch && allowed.contains(owner);}
  public synchronized void replace(List<Owner> owners) {
    try {
      if (epoch == Long.MAX_VALUE) throw new IllegalStateException("Identity access expired");
      if (owners == null || owners.size() > 64 || owners.stream().anyMatch(Objects::isNull)) throw new IllegalArgumentException("Identity access limit");
      Set<Owner> next = new HashSet<>(owners);
      if (next.size() != owners.size()) throw new IllegalArgumentException("Duplicate identity access owner");
      if (!next.containsAll(allowed)) advance();
      allowed = next;
    } catch (RuntimeException error) {advance(); allowed.clear(); throw error;}
  }
  public synchronized void clear() {advance(); allowed.clear();}
  private void advance() {if (epoch == Long.MAX_VALUE) {allowed.clear(); throw new IllegalStateException("Identity access expired");} epoch++;}
}
