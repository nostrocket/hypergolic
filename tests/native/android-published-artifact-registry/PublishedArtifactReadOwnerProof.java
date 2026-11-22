package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class PublishedArtifactReadOwnerProof {
  private static int assertions;
  private static void check(boolean condition) {
    assertions++;
    if (!condition) throw new AssertionError("Read owner assertion " + assertions);
  }

  private static void genuineBytesInOrder() {
    byte[] bytes = new byte[PublishedArtifactReadOwner.CHUNK_BYTES + 5];
    Arrays.fill(bytes, (byte) 'x');
    byte[] smile = "🙂".getBytes(StandardCharsets.UTF_8);
    System.arraycopy(smile, 0, bytes, PublishedArtifactReadOwner.CHUNK_BYTES - 1, smile.length);
    PublishedArtifactReadOwner owner = new PublishedArtifactReadOwner(bytes);
    PublishedArtifactReadOwner.Chunk first = owner.read(0);
    check(first != null && first.sequence == 0 && first.byteLength == PublishedArtifactReadOwner.CHUNK_BYTES - 1);
    check(!first.done && first.totalBytes == bytes.length);
    check(Arrays.equals(first.text.getBytes(StandardCharsets.UTF_8), Arrays.copyOf(bytes, first.byteLength)));
    PublishedArtifactReadOwner.Chunk finalChunk = owner.read(1);
    check(finalChunk != null && finalChunk.sequence == 1 && finalChunk.byteLength == 6 && finalChunk.done);
    check(finalChunk.text.equals("🙂xx"));
    check(owner.read(2) == null);
    check(bytes[0] == 0 && bytes[bytes.length - 1] == 0);
  }

  private static void replaySkipAndTeardown() {
    byte[] replay = "replay".getBytes(StandardCharsets.UTF_8);
    PublishedArtifactReadOwner replayOwner = new PublishedArtifactReadOwner(replay);
    check(replayOwner.read(1) == null);
    check(replayOwner.read(0) == null && replay[0] == 0);
    byte[] skipped = new byte[PublishedArtifactReadOwner.CHUNK_BYTES + 1];
    Arrays.fill(skipped, (byte) 7);
    PublishedArtifactReadOwner skippedOwner = new PublishedArtifactReadOwner(skipped);
    check(skippedOwner.read(0) != null);
    check(skippedOwner.read(0) == null);
    check(skippedOwner.read(1) == null && skipped[skipped.length - 1] == 0);
    byte[] teardown = "teardown".getBytes(StandardCharsets.UTF_8);
    PublishedArtifactReadOwner teardownOwner = new PublishedArtifactReadOwner(teardown);
    teardownOwner.clear();
    check(teardownOwner.read(0) == null && teardown[0] == 0);
  }

  public static void main(String[] args) {
    genuineBytesInOrder();
    replaySkipAndTeardown();
    System.out.println("{\"status\":\"passed\",\"assertions\":" + assertions + "}");
  }
}
