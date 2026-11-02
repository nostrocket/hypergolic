import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import org.nostrocket.hypergolic.host.CapabilityLeaseRegistry;
import org.nostrocket.hypergolic.host.RelaySubscriptionRegistry;

public final class RelaySubscriptionProof {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Assertion " + checks); }
  public static void main(String[] args) {
    AtomicLong clock = new AtomicLong(100);
    CapabilityLeaseRegistry generations = new CapabilityLeaseRegistry(clock::get);
    RelaySubscriptionRegistry streams = new RelaySubscriptionRegistry(clock::get, generations::sessionActive);
    check(generations.register("one")); check(streams.admit("one", "snapshot") == null);
    streams.setForeground(true);
    String first = streams.admit("one", "immutable-one"); check(first != null);
    check(!streams.accept(first)); check("immutable-one".equals(streams.take(first))); check(streams.take(first) == null);
    check(streams.accept(first)); check(streams.connectionLimit(first) == 2); check(!streams.accept(first)); check(streams.isActive(first)); check(streams.mayDeliver(first));
    String outbox = streams.admit("one", "native-outbox", true); check(outbox != null); check(streams.connectionLimit(outbox) == 0); check(streams.take(outbox) != null); check(streams.accept(outbox)); check(streams.connectionLimit(outbox) == 16); streams.close(outbox); check(streams.connectionLimit(outbox) == 0);
    String pending = streams.admit("one", "pending"); check(pending != null); check(streams.admit("one", "overload") == null);
    clock.addAndGet(25_000); check(streams.take(pending) == null); check(streams.isActive(first));
    streams.setForeground(false); check(streams.isActive(first)); check(!streams.mayDeliver(first)); check(streams.admit("one", "background") == null);
    clock.addAndGet(100_000); check(streams.isActive(first)); streams.setForeground(true); check(streams.mayDeliver(first));
    generations.revoke("one"); check(!streams.isActive(first)); check(!streams.mayDeliver(first));
    check(generations.register("one")); check(!streams.isActive(first));
    String closed = streams.admit("one", "close"); check(closed != null); check(streams.take(closed) != null); check(streams.accept(closed));
    streams.close(closed); check(!streams.isActive(closed)); check(!streams.accept(closed));
    String revoked = streams.admit("one", "revoke"); check(revoked != null); streams.revoke("one"); check(streams.take(revoked) == null);
    check(streams.admit("missing", "forged") == null); check(streams.admit("one", "x".repeat(32_769)) == null);
    check(streams.admit("one", "界".repeat(10_923)) == null);
    Set<String> tokens = new HashSet<>();
    for (int i = 0; i < 4; i++) {
      String generation = "capacity-" + i; check(generations.register(generation));
      for (int j = 0; j < 2; j++) {String token = streams.admit(generation,"known"); check(token != null); check(tokens.add(token)); check(streams.take(token) != null); check(streams.accept(token));}
    }
    check(generations.register("extra")); check(streams.admit("extra", "overload") == null);
    streams.revokeAll(); for (String token : tokens) check(!streams.isActive(token));
    String exact = streams.admit("extra", "exact-expiry"); check(exact != null); clock.addAndGet(24_999); check(streams.take(exact) != null);
    clock.incrementAndGet(); check(!streams.accept(exact));
    System.out.println("{\"language\":\"Java\",\"checks\":" + checks + ",\"failed\":0}");
  }
}
