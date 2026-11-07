package org.nostrocket.hypergolic.host;

/** Decoder dimensions fitted within the visible native picture bounds. */
final class FiniteVideoSize {
  final int width;
  final int height;

  FiniteVideoSize(int width, int height) {
    if (width <= 0 || height <= 0) throw new IllegalArgumentException("Invalid video size");
    this.width = width;
    this.height = height;
  }

  FiniteVideoSize fit(int maximumWidth, int maximumHeight) {
    int availableWidth = Math.max(1, maximumWidth);
    int availableHeight = Math.max(1, maximumHeight);
    if ((long) width * availableHeight > (long) height * availableWidth) {
      return new FiniteVideoSize(availableWidth, Math.max(1, (int) ((long) height * availableWidth / width)));
    }
    return new FiniteVideoSize(Math.max(1, (int) ((long) width * availableHeight / height)), availableHeight);
  }
}
