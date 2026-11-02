package org.nostrocket.hypergolic.host;
public final class RoutingCoreTests {
  static int count = 0;
  static void expect(boolean value) { count++; if (!value) throw new AssertionError("Routing assertion " + count); }
  public static void main(String[] args) {
    String a = "a".repeat(64), b = "b".repeat(64);
    RoutingEndpointRegistry r = new RoutingEndpointRegistry();
    expect(!r.register("old", a, 0, true, true)); expect(r.synchronizeOwner(a, 0, true));
    expect(!r.synchronizeOwner(b, 0, true)); expect(!r.register("wrong-user", b, 0, true, true));
    expect(!r.register("wrong-epoch", a, 1, true, true)); expect(!r.register("none", a, 0, false, false));
    expect(r.register("source", a, 0, true, true)); expect(!r.register("source", a, 0, true, true));
    expect(!r.mayDeliver("source", "inc")); r.ready("source"); expect(r.mayDeliver("source", "inc"));
    expect(!r.mayReview("source")); r.focus("source", true); expect(r.mayReview("source"));
    long revision = r.revision(); r.focus("source", false); expect(r.revision() == revision); expect(r.mayDeliver("source", "inc")); expect(!r.mayReview("source"));
    expect(r.register("target", a, 0, false, true)); r.ready("target"); expect(r.mayDeliver("target", "inc")); expect(!r.mayDeliver("target", "intent"));
    r.foreground(false); expect(!r.mayDeliver("source", "inc")); expect(!r.matchesRevision(revision));
    r.foreground(true); expect(r.mayDeliver("source", "inc")); expect(!r.matchesRevision(revision));
    revision = r.revision(); expect(r.synchronizeOwner(a, 0, false)); expect(!r.mayDeliver("source", "inc")); expect(!r.matchesRevision(revision));
    expect(r.synchronizeOwner(a, 0, true)); expect(r.mayDeliver("source", "inc"));
    expect(r.synchronizeOwner(b, 1, true)); expect(!r.mayDeliver("source", "inc")); expect(!r.synchronizeOwner(a, 0, true));
    expect(r.register("new", b, 1, true, true)); r.ready("new"); expect(r.mayDeliver("new", "intent")); r.revoke("new"); expect(!r.mayDeliver("new", "intent"));
    RoutingEndpointRegistry limit = new RoutingEndpointRegistry(); expect(limit.synchronizeOwner(a, 0, true));
    for (int i=0;i<64;i++) expect(limit.register("endpoint-"+i,a,0,true,true));
    expect(!limit.register("overflow",a,0,true,true)); limit.revoke("endpoint-0"); expect(limit.register("replacement",a,0,true,true));
    RoutingEndpointRegistry presentation = new RoutingEndpointRegistry(); expect(presentation.synchronizeOwner(a, 0, true));
    expect(presentation.register("config-only", a, 0, false, false, false, true)); presentation.ready("config-only");
    expect(presentation.mayDeliver("config-only", "config")); expect(!presentation.mayDeliver("config-only", "notify")); expect(!presentation.mayDeliver("config-only", "intent")); expect(!presentation.mayDeliver("config-only", "inc"));
    presentation.focus("config-only", true); expect(presentation.mayReview("config-only")); presentation.focus("config-only", false); expect(!presentation.mayReview("config-only")); expect(presentation.mayDeliver("config-only", "config"));
    expect(presentation.register("notify-only", a, 0, false, false, true, false)); presentation.ready("notify-only"); expect(presentation.mayDeliver("notify-only", "notify")); expect(!presentation.mayDeliver("notify-only", "config"));
    long captured = presentation.revision(); presentation.foreground(false); expect(!presentation.mayDeliver("config-only", "config")); expect(!presentation.mayDeliver("notify-only", "notify")); expect(!presentation.matchesRevision(captured));
    presentation.foreground(true); expect(presentation.mayDeliver("config-only", "config")); expect(presentation.mayDeliver("notify-only", "notify"));
    presentation.revoke("config-only"); expect(!presentation.mayDeliver("config-only", "config")); expect(presentation.synchronizeOwner(b, 1, true)); expect(!presentation.mayDeliver("notify-only", "notify"));
    RoutingEndpointRegistry reviews = new RoutingEndpointRegistry(); expect(reviews.synchronizeOwner(a, 0, true));
    expect(reviews.register("settings", a, 0, false, false, false, true)); reviews.ready("settings");
    long deliveryRevision = reviews.revision(); expect(reviews.reviewRevision("settings") == -1); expect(reviews.reviewRevision("missing") == -1);
    expect(reviews.focus("settings", true)); long firstReview = reviews.reviewRevision("settings"); expect(firstReview >= 0);
    expect(!reviews.focus("settings", true)); expect(reviews.reviewRevision("settings") == firstReview);
    expect(reviews.focus("settings", false)); expect(reviews.reviewRevision("settings") == -1); expect(reviews.mayDeliver("settings", "config"));
    expect(reviews.focus("settings", true)); expect(reviews.reviewRevision("settings") > firstReview); expect(reviews.revision() == deliveryRevision);
    expect(reviews.register("peer", a, 0, false, true)); reviews.ready("peer"); long currentReview = reviews.reviewRevision("settings");
    expect(reviews.focus("peer", true)); expect(reviews.reviewRevision("settings") == currentReview); expect(reviews.matchesRevision(deliveryRevision));
    reviews.foreground(false); expect(reviews.reviewRevision("settings") == -1); reviews.foreground(true); expect(!reviews.matchesRevision(deliveryRevision));
    reviews.revoke("settings"); expect(reviews.reviewRevision("settings") == -1);
    System.out.println("Android routing core " + count + " assertions passed");
  }
}
