package org.nostrocket.hypergolic.proof;

import com.android.uiautomator.core.Configurator;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;

/** Shell-UID test observer: reads current native accessibility without an idle wait. */
public final class FastUiDump extends UiAutomatorTestCase {
  public void testSnapshot() {
    Configurator.getInstance().setWaitForIdleTimeout(0);
    getUiDevice().setCompressedLayoutHeirarchy(true);
    java.io.File output = new java.io.File("/data/local/tmp/hg-upload.xml");
    // Window roots may temporarily disappear during React/WebView layout. Require
    // a newly written nonempty snapshot instead of accepting the runner alone.
    for (int attempt = 0; attempt < 20; attempt++) {
      getUiDevice().dumpWindowHierarchy("hg-upload.xml");
      if (output.isFile() && output.length() > 0) return;
      sleep(100);
    }
    fail("No fresh native accessibility root");
  }
}
