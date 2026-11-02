package org.nostrocket.hypergolic.boundary;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.WebViewRenderProcess;
import android.webkit.WebViewClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import android.widget.FrameLayout;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONArray;
import org.json.JSONObject;
import org.nostrocket.hypergolic.host.CapabilityLeaseRegistry;
import org.nostrocket.hypergolic.host.NappletHostView;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Real WebView callbacks and unmodified native leases; no fabricated frame or guest authority. */
public final class BoundaryInstrumentation extends Instrumentation {
  private static final String PACKAGE = "org.nostrocket.hypergolic.androidboundaryprobe";
  private Bundle arguments;
  private Activity activity;
  private NappletHostView template;
  private FrameLayout container;
  private final List<Probe> owned = new ArrayList<>();
  private final JSONArray cases = new JSONArray();
  private int assertions;
  private String step = "initialization";
  private CapabilityLeaseRegistry leases;
  private Object transport;

  @Override public void onCreate(Bundle args) { super.onCreate(args); arguments = args; start(); }
  private void check(boolean condition, String description) {
    assertions++;
    if (!condition) throw new AssertionError(description);
  }
  private <T> T ui(Callable<T> action) throws Exception {
    AtomicReference<T> value = new AtomicReference<>();
    AtomicReference<Throwable> error = new AtomicReference<>();
    runOnMainSync(() -> { try { value.set(action.call()); } catch (Throwable failure) { error.set(failure); } });
    if (error.get() != null) throw new Exception("Native UI action failed", error.get());
    return value.get();
  }
  private Object field(Object owner, String name) throws Exception {
    Field value = owner.getClass().getDeclaredField(name); value.setAccessible(true); return value.get(owner);
  }
  private void until(String label, BooleanSupplier predicate) throws Exception {
    long end = SystemClock.elapsedRealtime() + 15_000;
    while (!ui(predicate::getAsBoolean)) {
      if (SystemClock.elapsedRealtime() >= end) throw new AssertionError("Timeout: " + label);
      SystemClock.sleep(20);
    }
  }
  private NappletHostView find(View view) {
    if (view instanceof NappletHostView) return (NappletHostView) view;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) {
        NappletHostView found = find(group.getChildAt(i)); if (found != null) return found;
      }
    }
    return null;
  }
  private List<String> tokens(Probe p) throws Exception {
    synchronized (leases) {
      @SuppressWarnings("unchecked") Map<String, Object> pending = (Map<String, Object>) field(leases, "requests");
      List<String> result = new ArrayList<>();
      for (Map.Entry<String, Object> item : pending.entrySet())
        if (p.generation.equals(field(item.getValue(), "generation"))) result.add(item.getKey());
      return result;
    }
  }
  private String take(Probe p, String id) throws Exception {
    check(tokens(p).contains(id), "Token belongs to the exact observed generation");
    String snapshot = leases.take(id); check(snapshot != null, "One-use native claim succeeds"); return snapshot;
  }
  private void finish(String token, String response) throws Exception {
    transport.getClass().getMethod("finish", String.class, String.class).invoke(transport, token, response);
  }
  private void foreground(boolean value) throws Exception {
    ui(() -> { transport.getClass().getMethod("foreground", boolean.class).invoke(transport, value); return null; });
  }

  private final class Probe {
    final String session = "boundary-" + UUID.randomUUID();
    final String nonce = UUID.randomUUID().toString();
    final String observer = "BoundaryObserver" + nonce.replace("-", "");
    final JSONArray frames = new JSONArray();
    final JSONArray observations = new JSONArray();
    final Map<String, JSONObject> results = new HashMap<>();
    final Map<String, JavaScriptReplyProxy> frameReplies = new HashMap<>();
    NappletHostView host;
    WebView view;
    ScriptHandler script;
    String generation;
    boolean closed;
    Probe() throws Exception {
      owned.add(this);
      ui(() -> {
        host = new NappletHostView(template.getContext(), template.getAppContext());
        host.setId(View.generateViewId());
        container.addView(host, new FrameLayout.LayoutParams(-1, -1));
        view = (WebView) field(host, "webView");
        generation = (String) field(host, "generation");
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER), "Actual native listener available");
        check(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT), "Frame observer injection available");
        WebViewCompat.addWebMessageListener(view, observer, java.util.Set.of("*"), (source, message, origin, main, reply) -> {
          try {
            check(source == view, "Diagnostic callback belongs to this actual WebView");
            JSONObject data = new JSONObject(message.getData());
            if (!nonce.equals(data.optString("nonce"))) return;
            data.put("nativeOrigin", origin.toString()).put("nativeMainFrame", main);
            if ("frame".equals(data.optString("kind"))) {
              frames.put(data); frameReplies.put(origin.toString() + "|" + data.getString("href"), reply);
            } else if ("result".equals(data.optString("kind"))) {
              observations.put(data); results.put(data.getString("id"), data);
            }
          } catch (Exception error) { results.put("observer-failure", new JSONObject()); }
        });
        String source = "(() => {const nonce=" + JSONObject.quote(nonce) + ", observer=window[" + JSONObject.quote(observer) + "];"
          + "const report=value=>observer.postMessage(JSON.stringify({nonce,...value}));"
          + "observer.onmessage=async event=>{const command=JSON.parse(event.data);if(command.nonce!==nonce)return;try{let value;"
          + "if(command.operation==='isolation'){let parentBlocked=false,storageBlocked=false;try{void parent.document.body;}catch{parentBlocked=true;}"
          + "try{localStorage.setItem('boundary-owned','literal');}catch{storageBlocked=true;}"
          + "value={parentBlocked,storageBlocked,nativeBridge:typeof HypergolicHost,reactBridge:typeof ReactNativeWebView,"
          + "ready:document.querySelector('[data-testid=lab]')?.dataset.ready,theme:document.getElementById('theme-status')?.textContent};}"
          + "else if(command.operation==='send'){const available=typeof HypergolicHost!=='undefined';if(available)HypergolicHost.postMessage(command.wire);value={sent:available};}"
          + "else if(command.operation==='barrier'){value=await new Promise((resolve,reject)=>{const id=command.id;"
          + "const timeout=setTimeout(()=>{removeEventListener('message',listen);reject(Error('Theme barrier timeout'));},2000);"
          + "const listen=event=>{if(event.source!==parent||event.data?.id!==id)return;clearTimeout(timeout);removeEventListener('message',listen);resolve(event.data);};"
          + "addEventListener('message',listen);parent.postMessage({type:'theme.get',id},'*');});}"
          + "else if(command.operation==='network'){" + NetworkProbe.SCRIPT + "}"
          + "else throw Error('Unknown diagnostic operation');report({kind:'result',id:command.id,value});}"
          + "catch(error){report({kind:'result',id:command.id,error:String(error)});}};"
          + "addEventListener('DOMContentLoaded',()=>report({kind:'frame',href:location.href,nativeBridge:typeof HypergolicHost}),{once:true});})();";
        script = WebViewCompat.addDocumentStartJavaScript(view, source, java.util.Set.of("*"));
        JSONObject config = new JSONObject().put("sessionId", session).put("epoch", 3)
          .put("user", "1".repeat(64)).put("publisher", "2".repeat(64)).put("appId", "ux-lab")
          .put("version", "3".repeat(64)).put("instanceId", "native-boundary-instance")
          .put("fixture", "ux-lab").put("domains", new JSONArray().put("theme"));
        host.startConfiguredSession(config.toString()); return null;
      });
      until("actual native ready and real opaque guest frame", () -> {
        try { return Boolean.TRUE.equals(field(host, "ready")) && frameReplies.containsKey("null|about:srcdoc"); }
        catch (Exception error) { return false; }
      });
      check(!Boolean.TRUE.equals(ui(() -> field(host, "disposed"))), "Bootstrap remains live");
      check(ui(() -> frames.toString()).contains("\"nativeMainFrame\":true"), "Observed genuine main callback");
      JSONObject isolation = guest("isolation", null);
      // A settled original SDK response is mandatory; injection alone is not readiness.
      long end = SystemClock.elapsedRealtime() + 5_000;
      while (!"Host colors".equals(isolation.optString("theme")) || !"true".equals(isolation.optString("ready"))) {
        if (SystemClock.elapsedRealtime() >= end) throw new AssertionError("Original SDK theme not ready");
        SystemClock.sleep(20); isolation = guest("isolation", null);
      }
      barrier();
    }
    JSONObject command(String href, String operation, String wire) throws Exception {
      String id = UUID.randomUUID().toString();
      JSONObject command = new JSONObject().put("nonce", nonce).put("id", id).put("operation", operation);
      if (wire != null) command.put("wire", wire);
      ui(() -> { check(frameReplies.containsKey("null|" + href), "Real native frame reply proxy exists"); frameReplies.get("null|" + href).postMessage(command.toString()); return null; });
      until("frame-scoped result " + operation, () -> results.containsKey(id) || results.containsKey("observer-failure"));
      JSONObject result = ui(() -> results.get(id));
      check(result != null && !result.has("error"), "Frame operation succeeded");
      if ("about:srcdoc".equals(href)) {
        check(!result.getBoolean("nativeMainFrame"), "Original guest result came from genuine child frame");
        check("null".equals(result.getString("nativeOrigin")), "Original guest has opaque native origin");
      }
      return result.getJSONObject("value");
    }
    JSONObject guest(String operation, String wire) throws Exception { return command("about:srcdoc", operation, wire); }
    JSONObject main(String body) throws Exception {
      String id = UUID.randomUUID().toString();
      String source = "(async()=>{try{const value=await(async()=>{" + body + "})();"
        + observer + ".postMessage(JSON.stringify({nonce:" + JSONObject.quote(nonce) + ",kind:'result',id:"
        + JSONObject.quote(id) + ",value}));}catch(error){" + observer
        + ".postMessage(JSON.stringify({nonce:" + JSONObject.quote(nonce) + ",kind:'result',id:"
        + JSONObject.quote(id) + ",error:String(error)}));}})();";
      ui(() -> { view.evaluateJavascript(source, null); return null; });
      until("native main-frame evaluation", () -> results.containsKey(id) || results.containsKey("observer-failure"));
      JSONObject result = ui(() -> results.get(id));
      check(result != null && !result.has("error"), "Native main-frame evaluation succeeded");
      check(result.getBoolean("nativeMainFrame"), "Result came from actual main frame");
      check(NappletHostView.ORIGIN.equals(result.getString("nativeOrigin")), "Exact native main-frame origin");
      return result.getJSONObject("value");
    }
    void barrier() throws Exception {
      JSONObject response = guest("barrier", null);
      check("theme.get.result".equals(response.getString("type")), "Parent-source correlated theme barrier");
      JSONObject colors = response.getJSONObject("theme").getJSONObject("colors");
      check("#140f0b".equals(colors.getString("background")) && "#f3efeb".equals(colors.getString("text")) && "#e8805d".equals(colors.getString("primary")), "Exact existing theme palette");
    }
    void send(int... sequences) throws Exception {
      JSONArray values = new JSONArray(); for (int sequence : sequences) values.put(sequence);
      main("if(!window.boundaryReplies){window.boundaryReplies={};HypergolicHost.addEventListener('message',event=>{"
        + "const response=JSON.parse(event.data);if(response.type==='capability.result'&&response.sessionId==="
        + JSONObject.quote(generation) + "){window.boundaryReplies[response.sequence]=response;}});}"
        + "for(const sequence of " + values + "){HypergolicHost.postMessage(JSON.stringify({type:'capability',sessionId:"
        + JSONObject.quote(generation) + ",sequence,message:JSON.stringify({type:'storage.set',id:'native-'+sequence,key:'literal',value:'public test data'})}));}return {sent:true};");
    }
    JSONObject response(int sequence) throws Exception {
      return main("const deadline=performance.now()+3000;while(!window.boundaryReplies?.[" + sequence + "]){"
        + "if(performance.now()>deadline)throw Error('Missing real native response');await new Promise(resolve=>setTimeout(resolve,10));}return window.boundaryReplies[" + sequence + "];" );
    }
    void close() throws Exception {
      if (closed) return; closed = true;
      ui(() -> { if (!Boolean.TRUE.equals(field(host, "disposed"))) { script.remove(); WebViewCompat.removeWebMessageListener(view, observer); host.destroySession(); } container.removeView(host); return null; });
    }
    JSONObject receipt() throws Exception {
      return new JSONObject().put("session", session).put("generation", generation).put("frames", frames)
        .put("observations", observations).put("closed", closed);
    }
  }
  private String wire(Probe p, int sequence) throws Exception {
    return new JSONObject().put("type", "capability").put("sessionId", p.generation).put("sequence", sequence)
      .put("message", new JSONObject().put("type", "storage.set").put("id", "native-probe").put("key", "literal").put("value", "public test data").toString()).toString();
  }
  private void passed(String name, int before) throws Exception {
    cases.put(new JSONObject().put("name", name).put("status", "passed").put("assertions", assertions - before));
  }
  private void isolation() throws Exception {
    step = "real-frame-and-opaque-isolation"; int before = assertions; Probe p = new Probe();
    JSONObject value = p.guest("isolation", null);
    check(value.getBoolean("parentBlocked") && value.getBoolean("storageBlocked"), "Actual opaque parent and local storage denial");
    check("undefined".equals(value.getString("nativeBridge")) && "undefined".equals(value.getString("reactBridge")), "Privileged bridges absent from real opaque guest");
    check(!p.guest("send", wire(p, 1)).getBoolean("sent"), "Guest cannot invoke privileged bridge");
    p.barrier(); p.send(1);
    until("positive main-frame native admission", () -> { try { return tokens(p).size() == 1; } catch (Exception error) { return false; } });
    String token = tokens(p).get(0); JSONObject snapshot = new JSONObject(take(p, token));
    JSONObject registration = snapshot.getJSONObject("registration");
    check(p.generation.equals(registration.getString("generation")) && p.session.equals(registration.getString("sessionId")), "Native immutable registration and exact generation");
    check(registration.getJSONArray("domains").toString().equals("[\"theme\"]"), "Storage-shaped transport does not grant storage authority");
    check(leases.take(token) == null, "One-use claim blocks replay"); finish(token, "literal reply");
    check("literal reply".equals(p.response(1).getString("response")), "Real generation-bound native reply");
    p.close(); passed(step, before);
  }
  private void schema() throws Exception {
    step = "native-schema-generation-and-replay"; int before = assertions; Probe p = new Probe();
    JSONArray invalid = new JSONArray().put("not JSON").put("null").put("[]")
      .put(new JSONObject(wire(p, 1)).put("sessionId", "forged-generation").toString())
      .put(new JSONObject(wire(p, 1)).put("sequence", "1").toString())
      .put(new JSONObject(wire(p, 1)).put("sequence", 0).toString())
      .put(new JSONObject(wire(p, 1)).put("sequence", 1.5).toString())
      .put(new JSONObject(wire(p, 1)).put("extra", true).toString());
    p.main("for(const wire of " + invalid + ")HypergolicHost.postMessage(wire);return {sent:true};");
    p.barrier(); check(tokens(p).isEmpty(), "Malformed wires cannot create native leases");
    p.send(1); until("one valid lease after rejected wire batch", () -> { try { return tokens(p).size() == 1; } catch (Exception error) { return false; } });
    String token = tokens(p).get(0); take(p, token); finish(token, "valid"); p.response(1);
    p.send(1); p.barrier(); check(tokens(p).isEmpty(), "Consumed sequence cannot be replayed after finish");
    p.send(2); until("fresh sequence after replay", () -> { try { return tokens(p).size() == 1; } catch (Exception error) { return false; } });
    String fresh = tokens(p).get(0); check(!fresh.equals(token), "Fresh one-use authority differs"); take(p, fresh); finish(fresh, "fresh");
    check("fresh".equals(p.response(2).getString("response")), "Fresh response reaches the exact sequence");
    p.close(); passed(step, before);
  }
  private void childFrame() throws Exception {
    step = "actual-same-origin-child-native-rejection"; int before = assertions; Probe p = new Probe();
    p.main("const frame=document.createElement('iframe');frame.srcdoc='<!doctype html><title>boundary child</title>';frame.id='native-boundary-child';document.body.append(frame);return {created:true};");
    // Both frames have about:srcdoc URLs; select the genuine same-origin callback, never a fabricated frame.
    until("real same-origin child callback", () -> {
      for(int i=0;i<p.frames.length();i++){JSONObject f=p.frames.optJSONObject(i);if(f!=null&&!f.optBoolean("nativeMainFrame")&&NappletHostView.ORIGIN.equals(f.optString("nativeOrigin")))return true;}return false;
    });
    check(!Boolean.TRUE.equals(ui(() -> field(p.host, "disposed"))), "Child creation did not destroy the native session");
    // Select the actual matching-origin child proxy separately from the original opaque guest.
    String id = UUID.randomUUID().toString();
    JSONObject command = new JSONObject().put("nonce",p.nonce).put("id",id).put("operation","send").put("wire",wire(p,1));
    ui(() -> {p.frameReplies.get(NappletHostView.ORIGIN + "|about:srcdoc").postMessage(command.toString());return null;});
    until("actual child bridge attempt result", () -> p.results.containsKey(id));
    JSONObject result=ui(()->p.results.get(id));
    check(!result.getBoolean("nativeMainFrame")&&NappletHostView.ORIGIN.equals(result.getString("nativeOrigin")),"Attack originates in actual matching-origin child");
    check(result.getJSONObject("value").getBoolean("sent"),"Actual child has origin-matched bridge and invokes it");
    check(tokens(p).isEmpty(),"Matching origin alone grants no main-frame native authority");
    // Original guest SDK barrier and main-frame positive control both follow the rejected child request.
    p.barrier();
    p.send(1); until("exact sequence remains available to real main frame", () -> {try{return tokens(p).size()==1;}catch(Exception error){return false;}});
    String token=tokens(p).get(0);take(p,token);finish(token,"main only");check("main only".equals(p.response(1).getString("response")),"Child rejection preserves main sequence");
    p.close();passed(step,before);
  }
  private void bounds() throws Exception {
    step="actual-native-queue-bounds";int before=assertions;Probe first=new Probe(),second=new Probe(),third=new Probe();
    first.send(1,2,3,4,5);check(first.response(5).isNull("response"),"Fifth own request denied");
    second.send(1,2,3,4);until("eight total native leases",()->{try{return tokens(first).size()==4&&tokens(second).size()==4;}catch(Exception error){return false;}});
    third.send(1);check(third.response(1).isNull("response"),"Ninth global request denied");check(tokens(third).isEmpty(),"Global overload creates no authority");
    List<String> firstTokens=tokens(first), secondTokens=tokens(second);
    for(String token:firstTokens)take(first,token);for(String token:secondTokens)take(second,token);
    String freed=firstTokens.get(0);finish(freed,"freed");until("claimed lease finishes",()->!leases.isActive(freed));
    third.send(1,2);until("only fresh sequence after global overload",()->{try{return tokens(third).size()==1;}catch(Exception error){return false;}});
    String fresh=tokens(third).get(0);JSONObject snapshot=new JSONObject(take(third,fresh));
    check("native-2".equals(new JSONObject(snapshot.getString("request")).getString("id")),"Overloaded sequence consumed and replay denied");
    finish(fresh,"fresh");check("fresh".equals(third.response(2).getString("response")),"Fresh sequence gets own response");
    first.send(5,6);until("only fresh sequence after per-view overload",()->{try{return tokens(first).size()==4;}catch(Exception error){return false;}});
    List<String> added=new ArrayList<>(tokens(first));added.removeAll(firstTokens);check(added.size()==1,"Exactly one new per-view authority after overload replay");
    String perView=added.get(0);JSONObject perViewSnapshot=new JSONObject(take(first,perView));
    check("native-6".equals(new JSONObject(perViewSnapshot.getString("request")).getString("id")),"Per-view overloaded sequence consumed and cannot replay after capacity frees");
    finish(perView,"per-view fresh");check("per-view fresh".equals(first.response(6).getString("response")),"Fresh per-view sequence gets its own native response");
    first.close();second.close();third.close();passed(step,before);
  }
  private void lifecycle() throws Exception {
    step="native-foreground-and-close-revocation";int before=assertions;Probe p=new Probe();p.send(1,2);
    until("claimed plus queued requests",()->{try{return tokens(p).size()==2;}catch(Exception error){return false;}});
    List<String> pending=tokens(p);take(p,pending.get(0));foreground(false);
    check(p.response(1).isNull("response")&&p.response(2).isNull("response"),"Explicit native foreground input revokes both replies");
    for(String token:pending)check(!leases.isActive(token)&&leases.take(token)==null,"No claimed or queued authority survives background input");
    foreground(true);p.send(3);until("fresh work after foreground input",()->{try{return tokens(p).size()==1;}catch(Exception error){return false;}});
    String fresh=tokens(p).get(0);take(p,fresh);p.close();check(!leases.sessionActive(p.generation)&&!leases.isActive(fresh),"Actual view destruction revokes generation and claim");
    finish(fresh,"stale");Probe next=new Probe();check(!next.generation.equals(p.generation),"Replacement native generation differs");
    next.send(1);until("replacement native admission",()->{try{return tokens(next).size()==1;}catch(Exception error){return false;}});
    String replacement=tokens(next).get(0);take(next,replacement);finish(replacement,"replacement only");
    check("replacement only".equals(next.response(1).getString("response")),"Replacement receives only current reply");
    check(next.main("return {count:Object.keys(window.boundaryReplies).length};").getInt("count")==1,"No stale callback crosses native generation");
    next.close();passed(step,before);
  }
  private void utf8() throws Exception {
    step="actual-native-utf8-wire-and-snapshot-bounds";int before=assertions;Probe p=new Probe();
    int limit=CapabilityLeaseRegistry.MAX_BYTES;
    JSONObject envelope=p.main("let wire=JSON.stringify({type:'capability',sessionId:"+JSONObject.quote(p.generation)
      +",sequence:1,message:JSON.stringify({type:'storage.set',id:'oversize-wire',key:'literal',value:'é'.repeat(1048400)})});"
      +"const bytes=new TextEncoder().encode(wire).length;if(bytes>"+limit+")throw Error('Probe envelope baseline too large');"
      +"wire+=' '.repeat("+(limit+1)+"-bytes);HypergolicHost.postMessage(wire);return {bytes:new TextEncoder().encode(wire).length,characters:wire.length};");
    check(envelope.getInt("bytes")==limit+1&&envelope.getInt("characters")<limit,"Actual valid UTF-8 envelope exceeds byte bound despite fewer characters");
    p.barrier();check(tokens(p).isEmpty(),"Oversized native envelope creates no authority");
    p.send(1);until("valid sequence survives oversized wire",()->{try{return tokens(p).size()==1;}catch(Exception error){return false;}});
    String first=tokens(p).get(0);JSONObject snapshot=new JSONObject(take(p,first));
    check("native-1".equals(new JSONObject(snapshot.getString("request")).getString("id")),"Admitted snapshot belongs to the positive small request");
    JSONObject registration=snapshot.getJSONObject("registration");
    String largeRequest=new JSONObject().put("type","storage.set").put("id","oversize-snapshot").put("key","literal").put("value","é".repeat(1048476)).toString();
    int nativeBytes=new JSONObject().put("registration",registration).put("request",largeRequest).toString().getBytes(StandardCharsets.UTF_8).length;
    check(nativeBytes>limit,"Exact captured registration plus request exceeds native snapshot byte bound");
    p.observations.put(new JSONObject().put("capturedNativeSnapshotBytes",nativeBytes).put("limit",limit).put("generation",p.generation));
    finish(first,"before-byte-denial");check("before-byte-denial".equals(p.response(1).getString("response")),"First exact native reply remains valid");
    JSONObject wire=p.main("const wire=JSON.stringify({type:'capability',sessionId:"+JSONObject.quote(p.generation)
      +",sequence:2,message:JSON.stringify({type:'storage.set',id:'oversize-snapshot',key:'literal',value:'é'.repeat(1048476)})});"
      +"HypergolicHost.postMessage(wire);return {bytes:new TextEncoder().encode(wire).length};");
    check(wire.getInt("bytes")<=limit,"Actual wire is within bound while the native snapshot is oversized");
    check(p.response(2).isNull("response"),"Native snapshot byte bound denies the request");
    check(tokens(p).isEmpty(),"Snapshot rejection creates no lease");
    p.send(2,3);until("only fresh sequence after snapshot denial",()->{try{return tokens(p).size()==1;}catch(Exception error){return false;}});
    String fresh=tokens(p).get(0);JSONObject freshSnapshot=new JSONObject(take(p,fresh));
    check("native-3".equals(new JSONObject(freshSnapshot.getString("request")).getString("id")),"Snapshot denial consumes its sequence and rejects replay");
    finish(fresh,"after-byte-denial");check("after-byte-denial".equals(p.response(3).getString("response")),"Fresh exact response after byte denial");
    p.close();passed(step,before);
  }
  private void renderer() throws Exception {
    step="actual-renderer-termination-and-fresh-generation";int before=assertions;Probe p=new Probe();
    check(android.os.Build.VERSION.SDK_INT>=29,"Public renderer termination requires Android API29 or newer");
    WebViewRenderProcess oldProcess=ui(()->p.view.getWebViewRenderProcess());check(oldProcess!=null,"Real out-of-process renderer handle exists");
    p.send(1,2);until("claimed and queued work before real renderer termination",()->{try{return tokens(p).size()==2;}catch(Exception error){return false;}});
    List<String> pending=tokens(p);take(p,pending.get(0));
    check(ui(oldProcess::terminate),"Actual public native renderer termination succeeds");
    until("production render-process-gone destroys host and revokes generation",()->{try{return Boolean.TRUE.equals(field(p.host,"disposed"))&&!leases.sessionActive(p.generation);}catch(Exception error){return false;}});
    check(ui(()->p.host.getChildCount())==0&&ui(()->p.view.getParent())==null,"Production renderer fault removes the real destroyed WebView");
    for(String token:pending)check(!leases.isActive(token)&&leases.take(token)==null,"No claimed or queued authority survives actual renderer death");
    p.observations.put(new JSONObject().put("fault","public-Android-renderer-termination").put("generation",p.generation).put("oldRendererHandle",System.identityHashCode(oldProcess)));
    p.close();Probe next=new Probe();WebViewRenderProcess nextProcess=ui(()->next.view.getWebViewRenderProcess());
    check(nextProcess!=null&&nextProcess!=oldProcess,"New real renderer handle differs after death");check(!next.generation.equals(p.generation),"Fresh immutable native generation after renderer death");
    for(String token:pending)finish(token,"stale-renderer-reply");
    next.send(1);until("fresh renderer admits its own request",()->{try{return tokens(next).size()==1;}catch(Exception error){return false;}});
    String fresh=tokens(next).get(0);take(next,fresh);finish(fresh,"fresh-renderer-only");
    check("fresh-renderer-only".equals(next.response(1).getString("response")),"Replacement renderer receives current response only");
    check(next.main("return {count:Object.keys(window.boundaryReplies).length};").getInt("count")==1,"Stale callbacks cannot reach replacement renderer");
    next.observations.put(new JSONObject().put("freshRendererHandle",System.identityHashCode(nextProcess)).put("generation",next.generation));
    next.close();passed(step,before);
  }
  private void receiverControl(String target, String name) throws Exception {
    AtomicReference<String> result=new AtomicReference<>();
    AtomicReference<String> error=new AtomicReference<>();
    WebView control=ui(()->{
      WebView view=new WebView(activity);container.addView(view,new FrameLayout.LayoutParams(-1,-1));
      view.getSettings().setJavaScriptEnabled(true);
      view.setWebViewClient(new WebViewClient(){
        @Override public void onPageFinished(WebView view,String url){
          if(!target.equals(url)){error.set("Unexpected control navigation");return;}
          view.evaluateJavascript("document.body.textContent",result::set);
        }
        @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError failure){
          if(request.isForMainFrame())error.set("Receiver control load failed");
        }
      });
      view.loadUrl(target);return view;
    });
    try {
      until("independent WebView receiver control "+name,()->result.get()!=null||error.get()!=null);
      check(error.get()==null,"Unrestricted same-app WebView reaches independent receiver");
      check("boundary-control-ok".equals(new JSONArray("["+result.get()+"]").getString(0).trim()),"Exact receiver control body");
    } finally {ui(()->{control.stopLoading();container.removeView(control);control.destroy();return null;});}
  }
  private void network() throws Exception {
    step="independent-network-receiver-and-guest-denials";int before=assertions;
    String origin=arguments.getString("receiverURL",""),nonce=arguments.getString("receiverNonce","");
    URI uri=new URI(origin);
    check("http".equals(uri.getScheme())&&uri.getHost()!=null&&uri.getPort()>0&&uri.getRawPath().isEmpty()&&uri.getRawUserInfo()==null&&uri.getRawQuery()==null&&uri.getRawFragment()==null&&nonce.matches("[a-f0-9]{32}"),"Explicit bounded receiver configuration");
    check(getTargetContext().getApplicationInfo().flags!=0&&(getTargetContext().getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_USES_CLEARTEXT_TRAFFIC)!=0,"Test-only receiver control overlay active");
    String base=origin+"/"+nonce;
    receiverControl(base+"/control/before","before");
    Probe p=new Probe();JSONObject value=p.guest("network",new JSONObject().put("target",base+"/guest").toString());
    JSONObject denied=value.getJSONObject("denied");
    check(denied.length()==8,"Exact eight observable API outcomes");
    for(String method:new String[]{"fetch","xhr","websocket","image","script","css","worker","popup"})check(denied.getBoolean(method),"Real guest denial: "+method);
    JSONArray violations=value.getJSONArray("violations");
    String[][] required={{"fetch","connect-src"},{"xhr","connect-src"},{"websocket","connect-src"},{"image","img-src"},{"script","script-src","script-src-elem"},{"css","style-src","style-src-elem"}};
    for(String[] requirement:required){
      boolean observed=false;
      for(int i=0;i<violations.length();i++){
        JSONObject violation=violations.getJSONObject(i);boolean directive=false;
        for(int j=1;j<requirement.length;j++)if(requirement[j].equals(violation.getString("directive")))directive=true;
        if(directive&&violation.getString("uri").endsWith("/"+nonce+"/guest/"+requirement[0]))observed=true;
      }
      check(observed,"Exact effective CSP directive and nonce-bound URI: "+requirement[0]);
    }
    JSONObject form=value.getJSONObject("form");
    check((base+"/guest/form").equals(form.getString("action"))&&"post".equals(form.getString("method"))&&form.getBoolean("connected")&&form.getBoolean("locationUnchanged"),"Real form submission cannot navigate original guest");
    check("allow-scripts".equals(p.main("return {sandbox:document.querySelector('#napplet').getAttribute('sandbox')};").getString("sandbox")),"Original sandbox restrictions retained");
    p.barrier();p.close();receiverControl(base+"/control/after","after");passed(step,before);
  }
  @Override public void onStart() {
    Bundle result=new Bundle();
    try {
      check(PACKAGE.equals(getTargetContext().getPackageName()),"Refuse primary or QA product target");
      check(arguments!=null&&arguments.getString("runId", "").matches("[A-Za-z0-9_-]{1,80}"),"Explicit bounded run identifier required");
      Class<?> owner=Class.forName("org.nostrocket.hypergolic.host.CapabilityTransport");
      transport=owner.getField("INSTANCE").get(null);leases=(CapabilityLeaseRegistry)owner.getMethod("getLeases").invoke(transport);
      Class<?> config=Class.forName("org.nostrocket.hypergolic.host.BuildConfig");
      check(!config.getField("UPLOAD_NETWORK_PROOF").getBoolean(null),"Production fault hooks remain disabled");
      Intent intent=new Intent(Intent.ACTION_MAIN).setComponent(new ComponentName(PACKAGE,"org.nostrocket.hypergolic.dev.MainActivity")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      activity=startActivitySync(intent);
      until("ordinary Expo host exists",()->{template=find(activity.getWindow().getDecorView());return template!=null;});
      ui(()->{container=new FrameLayout(activity);((ViewGroup)activity.findViewById(android.R.id.content)).addView(container,new ViewGroup.LayoutParams(-1,-1));return null;});
      isolation();schema();childFrame();bounds();lifecycle();utf8();renderer();
      if(arguments.containsKey("receiverURL")||arguments.containsKey("receiverNonce"))network();
      result.putString("result","passed");
    } catch(Throwable error) {
      result.putString("result","failed");result.putString("step",step);result.putString("errorType",error.getClass().getSimpleName());
      if(error instanceof AssertionError)result.putString("assertion",error.getMessage());
      // Only test-controlled diagnostics, no throwable/stack containing retained app data.
    } finally {
      for(Probe p:owned)try{p.close();}catch(Exception error){result.putString("result","failed");result.putString("cleanup","failed");}
      try{foreground(true);ui(()->{if(container!=null)((ViewGroup)container.getParent()).removeView(container);return null;});}catch(Exception error){result.putString("result","failed");}
      JSONArray probes=new JSONArray();for(Probe p:owned)try{probes.put(p.receipt());}catch(Exception error){result.putString("result","failed");}
      result.putString("cases",cases.toString());result.putString("probes",probes.toString());result.putInt("assertions",assertions);
      result.putString("scope","Unmodified production host in disposable ordinary Expo app; privileged native script stimulus and real native frame callbacks. No protected signer, storage authorization, OS background journey, packet-level egress or full SEC claim.");
      finish(Activity.RESULT_OK,result);
    }
  }
}
