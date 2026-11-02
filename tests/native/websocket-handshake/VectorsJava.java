package org.nostrocket.hypergolic.host;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Base64;

public final class VectorsJava {
  private static int assertions;
  public static void main(String[] args) throws Exception {
    for (String line : Files.readAllLines(Paths.get(args[0]))) {
      if (line.isEmpty() || line.startsWith("#")) continue;
      String[] fields = line.split("\\|", -1);
      byte[] nonce = Base64.getDecoder().decode(fields[1]);
      byte[] response = Base64.getDecoder().decode(fields[2]);
      boolean accepted;
      try { PublishedRelayWebSocketHandshake.validate(response, nonce); accepted = true; }
      catch (IllegalArgumentException expected) { accepted = false; }
      boolean want = fields[3].equals("accept");
      if (accepted != want) throw new AssertionError(fields[0] + " expected " + want + " got " + accepted);
      assertions++;
    }
    System.out.println("Java RFC6455 shared vectors: " + assertions + " passed");
  }
}
