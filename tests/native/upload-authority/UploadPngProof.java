package org.nostrocket.hypergolic.host;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

public final class UploadPngProof {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("PNG check " + checks); }
  public static void main(String[] args) throws Exception {
    Path root = Path.of(args[0]);
    String[] accepted = {"valid", "color"};
    String[] rejected = {"signature","truncated","crc","text","exif","icc","animation","unknown","duplicate-header","duplicate-color","late-color","interlaced","huge","bad-filter","short-pixels","extra-pixels","compressed-trailer","after-end","jpeg"};
    for (String name : accepted) { byte[] bytes = Files.readAllBytes(root.resolve(name + ".png")); check(Arrays.equals(bytes, UploadPngProfile.prepare(bytes))); }
    for (String name : rejected) check(UploadPngProfile.prepare(Files.readAllBytes(root.resolve(name + ".png"))) == null);
    for (String line : Files.readAllLines(root.resolve("png-metadata-cases.tsv"))) {
      String[] fields = line.split("\\t"); byte[] input = Files.readAllBytes(root.resolve(fields[0])), captured = input.clone();
      byte[] output = UploadPngMetadata.prepare(input);
      check(Arrays.equals(input, captured));
      if (fields[1].equals("DENY")) check(output == null);
      else { check(output != null); check(Arrays.equals(output, Files.readAllBytes(root.resolve(fields[1])))); check(UploadPngProfile.prepare(output) != null); }
    }
    var authority = new NativeUploadAuthority(() -> 0L); var session = authority.register("png-session", "11".repeat(32));
    authority.setForeground(true); authority.focus(session);
    byte[] bytes = Files.readAllBytes(root.resolve("valid.png"));
    var request = authority.admit(session, bytes.length, "https://files.example.org", "text/plain"); check(authority.append(request, 0, bytes));
    byte[] original = bytes.clone(); Arrays.fill(bytes, (byte)0);
    var review = authority.sealPreparedFile(request); check(review != null); check("image/png".equals(review.mimeType));
    check(Arrays.equals(authority.preview(request, review), original)); check(authority.sealPreparedFile(request) == null);
    authority.cancel(request);
    byte[] metadata = Files.readAllBytes(root.resolve("text.png"));
    var denied = authority.admit(session, metadata.length, "https://files.example.org", "image/png"); check(authority.append(denied, 0, metadata));
    var sanitized = authority.sealPreparedFile(denied); check(sanitized != null); check(Arrays.equals(authority.preview(denied, sanitized), original));
    check(sanitized.size == original.length);
    check(sanitized.sha256.equals(java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(original))));
    authority.cancel(denied);
    var stale = authority.admit(session, metadata.length, "https://files.example.org", "image/png"); check(authority.append(stale, 0, metadata));
    authority.setForeground(false); check(authority.sealPreparedFile(stale) == null); check(!authority.contains(stale));
    System.out.println("{\"language\":\"Java\",\"uploadPngChecks\":"+checks+",\"failed\":0}");
  }
}
