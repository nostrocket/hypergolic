package org.nostrocket.hypergolic.proof;

import com.android.uiautomator.core.Configurator;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;

/** Shell-UID observation only; requires a freshly written native accessibility root. */
public final class NotifyUiDump extends UiAutomatorTestCase {
  public void testSnapshot() {
    Configurator.getInstance().setWaitForIdleTimeout(0);
    getUiDevice().setCompressedLayoutHeirarchy(true);
    java.io.File output = new java.io.File("/data/local/tmp/hg-notify.xml");
    for (int attempt = 0; attempt < 20; attempt++) {
      getUiDevice().dumpWindowHierarchy("hg-notify.xml");
      if (output.isFile() && output.length() > 0) {
        String xml;
        try {
          xml = new String(java.nio.file.Files.readAllBytes(output.toPath()), java.nio.charset.StandardCharsets.UTF_8);
        } catch (java.io.IOException error) {
          throw new AssertionError("Native snapshot read failed", error);
        }
        boolean guestPending = xml.contains("android.webkit.WebView") && !xml.contains("resource-id=\"lab\"");
        if (!guestPending && attempt > 0) return;
      }
      sleep(200);
    }
    fail("No fresh native accessibility root");
  }
}
