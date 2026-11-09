package org.nostrocket.hypergolic.host;

public final class DockedImeViewportTests {
  public static void main(String[] args) {
    expect("old WebView with edge-to-edge keyboard", 815, 2400, 883, 2332, 2078);
    expect("parent already resized", 0, 2400, 883, 1517, 1263);
    expect("parent resized part way", 83, 2400, 883, 1600, 1346);
    expect("keyboard dismissed", 0, 2400, 0, 2332, 2078);
    expect("floating keyboard", 0, 2400, 0, 2332, 2078);
    expect("landscape window", 246, 1080, 280, 1046, 821);
    expect("offset multi-window uses its own height", 284, 900, 320, 864, 714);
    expect("invalid frame during layout", 0, 0, 280, 0, 0);
    expect("keyboard covers a small host", 149, 900, 600, 700, 150);
    System.out.println("Docked IME viewport geometry passed");
  }

  private static void expect(String description, int expected, int window, int ime, int bottom, int height) {
    int actual = DockedImeViewport.overlap(window, ime, bottom, height);
    if (actual != expected) throw new AssertionError(description + ": expected " + expected + ", got " + actual);
  }
}
