package org.nostrocket.hypergolic.host;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
public final class UploadExifProof {
  public static void main(String[] args) throws Exception {
    Path root = Path.of(args[0]); int checks = 0;
    for (String line : Files.readAllLines(root.resolve("exif-cases.tsv"))) {
      String[] fields = line.split("\\t"); byte[] input = Files.readAllBytes(root.resolve(fields[0])), before = input.clone();
      if (UploadExifMetadata.orientation(input, 0, input.length) != Integer.parseInt(fields[1])) throw new AssertionError(fields[0]); checks++;
      if (!Arrays.equals(input, before)) throw new AssertionError("Mutation"); checks++;
    }
    byte[] valid = Files.readAllBytes(root.resolve("exif-valid.tiff"));
    for (int length = 0; length < valid.length; length++) {
      if (UploadExifMetadata.orientation(Arrays.copyOf(valid, length), 0, length) != 0) throw new AssertionError("Truncation " + length); checks++;
    }
    if (UploadExifMetadata.orientation(valid, -1, valid.length) != 0 || UploadExifMetadata.orientation(valid, 1, valid.length) != 0 ||
      UploadExifMetadata.orientation(valid, 0, -1) != 0 || UploadExifMetadata.orientation(new byte[262145], 0, 262145) != 0) throw new AssertionError("Bounds"); checks++;
    System.out.println("{\"language\":\"Java\",\"exifChecks\":"+checks+",\"failed\":0}");
  }
}
