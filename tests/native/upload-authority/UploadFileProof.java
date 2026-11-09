package org.nostrocket.hypergolic.host;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
public final class UploadFileProof {
  private static int checks;
  private static void check(boolean value) {checks++; if (!value) throw new AssertionError("Attachment check " + checks);}
  private static void htmlProof() {
    var utf8 = java.nio.charset.StandardCharsets.UTF_8;
    byte[] bytes = "<!doctype html><html><body>Local selection</body></html>".getBytes(utf8);
    for (String text : new String[] {new String(bytes, utf8), "\uFEFF \n<!DOCTYPE\tHTML >\n<title>Local</title>", "\uFEFF \t\r\n<!DOCTYPE\tHTML \r\n>"}) {
      var prepared = UploadFileProfile.prepare(text.getBytes(utf8));
      check(prepared != null && prepared.mimeType().equals("text/html"));
      check(prepared.metadataPolicy().equals("attachment-unchanged"));
      check(Arrays.equals(prepared.bytes(), text.getBytes(utf8)));
    }
    byte[] limit = new byte[1024 * 1024]; Arrays.fill(limit, (byte)' ');
    byte[] prefix = "<!doctype html>".getBytes(utf8); System.arraycopy(prefix, 0, limit, 0, prefix.length);
    check(UploadFileProfile.prepare(limit).mimeType().equals("text/html"));
    byte[] oversized = Arrays.copyOf(limit, limit.length + 1); oversized[limit.length] = ' ';
    check(UploadFileProfile.prepare(oversized) == null);
    for (String text : new String[] {"<html><body>No doctype</body></html>", "<svg/>", "\uFEFF<svg/>",
        "<?xml version=\"1.0\"?><html/>", "<!doctype svg><svg/>", "<!doctype htmlx><html/>",
        "<!doctype html PUBLIC \"unselected\"><html/>", "<!doctype html>\u0000", "<!doctype html>\u007f",
        "<!doc\uFEFFtype html>", " \uFEFF<!doctype html>", "\uFEFF\uFEFF<!doctype html>", "<!doctype\fhtml>"}) {
      check(UploadFileProfile.prepare(text.getBytes(utf8)) == null);
    }
    byte[] invalidUtf8 = Arrays.copyOf(bytes, bytes.length + 2); invalidUtf8[bytes.length] = (byte)0xc3; invalidUtf8[bytes.length + 1] = 0x28;
    check(UploadFileProfile.prepare(invalidUtf8) == null);
    for (boolean revoke : new boolean[] {false, true}) {
      var owner = new NativeUploadAuthority(() -> 1000); var session = owner.register("html", "a".repeat(64));
      owner.setForeground(true); owner.focus(session);
      var request = owner.admit(session, bytes.length, "https://files.example.com", "image/png");
      check(request != null && owner.append(request, 0, bytes));
      var review = owner.sealPreparedFile(request); check(review != null);
      check(review.mimeType.equals("text/html") && review.size == bytes.length);
      check(review.sha256.equals("8e5a049a49491dbce8fb9f1e3b14856de88eefda52522e061079cd0ab49aa50b"));
      check(Arrays.equals(owner.preview(request, review), bytes));
      owner.focus(null); check(owner.approve(request, review) == null); owner.focus(session);
      var grant = owner.approve(request, review); check(grant != null);
      check(owner.dispatch(grant) == null && !owner.claimTransfer(grant));
      check(owner.claimSigning(grant) == review); check(owner.dispatch(grant) == null);
      check(owner.claimTransfer(grant));
      if (revoke) {owner.setForeground(false); check(!owner.isApproved(grant)); check(owner.dispatch(grant) == null);}
      else {check(Arrays.equals(owner.dispatch(grant), bytes)); check(owner.dispatch(grant) == null);}
    }
  }
  public static void main(String[] args) throws Exception {
    htmlProof();
    Path root = Path.of(args[0]); String[][] cases = {{"wav","audio/wav"},{"mp4","video/mp4"},{"pdf","application/pdf"},{"zip","application/zip"},{"txt","text/plain"}};
    for (String[] item : cases) {
      byte[] bytes = Files.readAllBytes(root.resolve("fixture." + item[0])), original = bytes.clone();
      UploadFileProfile.Prepared prepared = UploadFileProfile.prepare(bytes);
      check(prepared != null); check(Arrays.equals(bytes, original)); check(Arrays.equals(prepared.bytes(), bytes));
      check(prepared.mimeType().equals(item[1])); check(prepared.metadataPolicy().equals("attachment-unchanged"));
      prepared.bytes()[0] ^= 1; check(Arrays.equals(bytes, original));
      NativeUploadAuthority authority = new NativeUploadAuthority(() -> 1000);
      var session = authority.register("attachment", "a".repeat(64)); authority.setForeground(true); authority.focus(session);
      var request = authority.admit(session, bytes.length, "https://files.example.com", "image/jpeg");
      check(request != null); check(authority.append(request, 0, bytes));
      var review = authority.sealPreparedFile(request); check(review != null);
      check(review.mimeType.equals(item[1])); check(review.metadataPolicy.equals("attachment-unchanged")); check(review.size == bytes.length);
      check(review.acceptsDescriptorType(item[1])); check(review.acceptsDescriptorType("audio/x-wav") == item[0].equals("wav")); check(!review.acceptsDescriptorType("audio/mpeg-unknown"));
      check(Arrays.equals(authority.preview(request, review), bytes));
      var grant = authority.approve(request, review); check(grant != null); check(authority.claimSigning(grant) == review);
      check(authority.claimTransfer(grant)); check(Arrays.equals(authority.dispatch(grant), bytes));
      authority.setForeground(false); check(authority.preview(request, review) == null); check(!authority.isApproved(grant));
    }
    var spoof = new NativeUploadAuthority(() -> 1000); var spoofSession = spoof.register("spoof", "a".repeat(64));
    spoof.setForeground(true); spoof.focus(spoofSession);
    var spoofRequest = spoof.admit(spoofSession, 3, "https://files.example.com", "audio/wav");
    check(spoof.append(spoofRequest, 0, new byte[]{1,2,3})); check(!spoof.seal(spoofRequest).acceptsDescriptorType("audio/x-wav"));
    for (String value : new String[] {"<svg>private</svg>", "\uFEFF<svg>private</svg>", "GIF89aPHOTO", "II*private", "MMprivate"})
      check(UploadFileProfile.prepare(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)) == null);
    check(UploadFileProfile.prepare(new byte[NativeUploadAuthority.MAX_BYTES + 1]) == null);
    check(UploadFileProfile.prepare(new byte[] {(byte)255,(byte)216,1,2}) == null);
    for (String extension : new String[] {"wav","mp4"}) {
      byte[] bytes = Files.readAllBytes(root.resolve("fixture." + extension));
      for (int length = 0; length < bytes.length; length++) {
        // Empty and partial binary headers may be ordinary text, but a recognized container must fail closed.
        if (length >= 12) check(UploadFileProfile.prepare(Arrays.copyOf(bytes, length)) == null);
      }
    }
    byte[] movie = Files.readAllBytes(root.resolve("fixture.mp4")); System.arraycopy("heic".getBytes(java.nio.charset.StandardCharsets.US_ASCII),0,movie,8,4);
    check(UploadFileProfile.prepare(movie) == null);
    System.out.println("{\"language\":\"Java\",\"uploadFileChecks\":" + checks + ",\"failed\":0}");
  }
}
