package org.nostrocket.hypergolic.host;
public final class UploadJsonBoundsProof {
  public static void main(String[] args) {
    int checks = 0;
    String[] accepted = {"{}", "{\"a\":[{\"b\":true}]}", "\"[{quote}\\\"still quoted]\"", "[\"\\\\\"]", "[".repeat(12)+"0"+"]".repeat(12)};
    for (String value : accepted) { checks++; if (!UploadJsonBounds.accepts(value, 1024)) throw new AssertionError(value); }
    String[] rejected = {null, "[", "}", "\"open", "[".repeat(13)+"0"+"]".repeat(13), "x".repeat(1025), "é".repeat(513)};
    for (String value : rejected) { checks++; if (UploadJsonBounds.accepts(value, 1024)) throw new AssertionError(value); }
    System.out.println("{\"language\":\"Java\",\"uploadJsonBoundsChecks\":"+checks+",\"failed\":0}");
  }
}
