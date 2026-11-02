package org.nostrocket.hypergolic.host;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class PublicAddressPolicyProof {
  public static void main(String[] args) throws Exception {
    int checks = 0;
    for (String line : Files.readAllLines(Path.of(args[0]))) {
      if (line.isBlank() || line.startsWith("#")) continue;
      String[] fields = line.split("\\t", -1);
      boolean expected = Boolean.parseBoolean(fields[2]);
      boolean actual;
      if (fields[0].equals("LITERAL")) actual = PublicAddressPolicy.isPublicLiteral(fields[1]);
      else if (fields[0].equals("ANSWERS")) {
        List<String> answers = fields[1].isEmpty() ? List.of() : new ArrayList<>(Arrays.asList(fields[1].split(",", -1)));
        actual = PublicAddressPolicy.allPublicAnswers(answers);
      } else if (fields[0].equals("BYTES")) {
        byte[] address = new byte[fields[1].length() / 2];
        if (fields[1].length() % 2 != 0) throw new AssertionError("Odd-length byte vector: " + line);
        for (int i = 0; i < address.length; i++) address[i] = (byte) Integer.parseInt(fields[1].substring(i * 2, i * 2 + 2), 16);
        actual = PublicAddressPolicy.accepts(address);
      } else throw new AssertionError("Unknown vector type: " + fields[0]);
      if (actual != expected) throw new AssertionError("Vector " + (checks + 1) + " failed: " + line + " actual=" + actual);
      checks++;
    }
    System.out.println("Android/JVM classifier vectors passed: " + checks);
  }
}
