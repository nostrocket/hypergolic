package org.nostrocket.hypergolic.host;

final class DockedImeViewport {
  private DockedImeViewport() {}

  /** All dimensions are in pixels relative to the same window, before any guest margin. */
  static int overlap(int windowHeight, int imeBottom, int hostBottom, int hostHeight) {
    if (imeBottom <= 0 || imeBottom >= windowHeight || hostHeight <= 1) return 0;
    int keyboardTop = windowHeight - imeBottom;
    return Math.max(0, Math.min(hostBottom - keyboardTop, hostHeight - 1));
  }
}
