package org.nostrocket.hypergolic.host;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Private app credential profile; exact template/hash/scope checks complement the app's Schnorr verifier.
 * This parser does not itself verify Schnorr signatures or grant signing/dispatch authority. */
final class NativeBlossomPermit {
  final NativeUploadAuthority.Review review;
  final String authorization;
  final long createdAt, expiration;
  private NativeBlossomPermit(NativeUploadAuthority.Review review, String token, long createdAt, long expiration) {
    this.review = review; authorization = "Nostr " + token; this.createdAt = createdAt; this.expiration = expiration;
  }
  boolean validAt(long now) { return createdAt < now && now < expiration; }
  static NativeBlossomPermit capture(NativeUploadAuthority.Review review, String token, long now) {
    try {
      if (review == null || token == null || token.length() > 4096 || !token.matches("[A-Za-z0-9_-]+") || now < 1 || now > 9_007_199_254_740_991L) return null;
      byte[] decoded = Base64.getUrlDecoder().decode(token);
      if (!Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(token)) return null;
      String json = new String(decoded, StandardCharsets.UTF_8);
      String server = new URI(review.destination).getHost(), content = "Upload reviewed file to " + review.destination;
      String tagsStart = "[[\"t\",\"upload\"],[\"x\",\"" + review.sha256 + "\"],[\"server\",\"" + server + "\"],[\"expiration\",\"";
      String expression = Pattern.quote("{\"id\":\"") + "([0-9a-f]{64})" + Pattern.quote("\",\"pubkey\":\"" + review.identity + "\",\"created_at\":") + "([0-9]{1,16})" +
        Pattern.quote(",\"kind\":24242,\"tags\":" + tagsStart) + "([0-9]{1,16})" + Pattern.quote("\"]],\"content\":\"" + content + "\",\"sig\":\"") + "([0-9a-f]{128})" + Pattern.quote("\"}");
      Matcher match = Pattern.compile(expression).matcher(json); if (!match.matches()) return null;
      long created = Long.parseLong(match.group(2)), expiration = Long.parseLong(match.group(3));
      if (created < 1 || created >= now || created > 9_007_199_254_740_871L || expiration != created + 120 || expiration <= now) return null;
      String tags = tagsStart + expiration + "\"]]";
      String canonical = "[0,\"" + review.identity + "\"," + created + ",24242," + tags + ",\"" + content + "\"]";
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8));
      StringBuilder hash = new StringBuilder(64); for (byte value : digest) hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
      return hash.toString().equals(match.group(1)) ? new NativeBlossomPermit(review, token, created, expiration) : null;
    } catch (Exception invalid) { return null; }
  }
}
