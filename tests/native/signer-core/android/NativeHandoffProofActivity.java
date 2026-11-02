package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import java.nio.charset.StandardCharsets;
import org.nostrocket.hypergolic.host.NativeSourceHoldProof;

/** Disposable owning source/ticket tests only; no external browser or RPC continuation. */
public final class NativeHandoffProofActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    try {
      int source=NativeSourceHoldProof.run(), ticket=NativeHandoffTicketProof.run();
      String result="{\"status\":\"passed\",\"sourceAssertions\":"+source+",\"ticketAssertions\":"+ticket+"}";
      try(var output=openFileOutput("result.json",MODE_PRIVATE)){output.write(result.getBytes(StandardCharsets.UTF_8));}
      TextView text=new TextView(this);text.setText("Native source/ticket checks passed: "+(source+ticket));setContentView(text);
    } catch(Throwable failure) {
      TextView text=new TextView(this);text.setText("Native source/ticket checks failed");setContentView(text);
    }
  }
}
