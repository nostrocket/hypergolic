package org.nostrocket.hypergolic.host;
import android.os.Handler;
import org.json.JSONObject;

/** Deferred-main delivery with actual host registry: never an old source revived by fast resume. */
public final class CvmDeliveryRevisionProof {
  private static int checks;
  private static void check(boolean value){if(!value)throw new AssertionError("delivery "+checks);checks++;}
  private static String begin(String generation,String id,long timeout){String token=CvmHostFixture.ingress(generation,id,false,timeout);check(token!=null);check(CvmHostFixture.take(token)!=null);check(token.equals(CvmHostFixture.approve(token)));return token;}
  private static String event(){return "{\"type\":\"cvm.event\",\"server\":{\"pubkey\":\""+CvmHostFixture.PROVIDER+"\"},\"message\":{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progressToken\":\"owned\",\"progress\":1}}}";}
  private static long pushes(){return CvmHostFixture.responses.stream().filter(x->x.startsWith("PUSH:")).count();}
  public static void main(String[]args)throws Exception{
    CvmHostFixture.setup();check(CvmHostFixture.register("delivery",true,true));String token=begin("delivery","normal",30000),revision=CvmHostFixture.revision("delivery");
    check(CvmHostFixture.currentRevision("delivery",revision));check(!CvmHostFixture.currentRevision("delivery","forged"));
    String opaque=event().replace("\"owned\"","\"\\ud800\"");
    check(CvmHostFixture.sendRequest("delivery",revision,token,opaque));check(CvmHostFixture.responses.contains("PUSH:"+opaque));CvmHostFixture.responses.clear();
    check(!CvmHostFixture.sendCarrier("delivery",revision,token,new JSONObject().put("provider","a".repeat(64)).put("message",opaque).toString()));
    check(!CvmHostFixture.sendCarrier("delivery",revision,token,new JSONObject().put("provider",CvmHostFixture.PROVIDER).put("message",opaque).put("extra",true).toString()));
    check(!CvmHostFixture.sendCarrier("delivery",revision,token,new JSONObject().put("provider",CvmHostFixture.PROVIDER).put("message","x".repeat(40*1024+1)).toString()));
    check(!CvmHostFixture.sendCarrier("delivery",revision,token,event()));
    Handler.held=true;check(CvmHostFixture.send("delivery",revision,event()));CvmHostFixture.finish(token);check(pushes()==0);Handler.flush();check(pushes()==1);check(!CvmHostFixture.send("delivery",revision,event()));
    CvmHostFixture.responses.clear();String cancelled=begin("delivery","null-cancel",30000);
    var access=NativeCvmSourceFacade.acquire(cancelled);java.util.concurrent.atomic.AtomicInteger cancelledCallbacks=new java.util.concurrent.atomic.AtomicInteger();
    NativeCvmSourceFacade.watch("cancel-proof",access,new NativeCvmSourceFacade.Observer(){public void completed(String permit){throw new AssertionError("null completed");}public void cancel(){check(!access.current());cancelledCallbacks.incrementAndGet();}});
    String independent=begin("delivery","same-provider-independent",30000);var other=NativeCvmSourceFacade.acquire(independent);java.util.concurrent.atomic.AtomicInteger otherCancelled=new java.util.concurrent.atomic.AtomicInteger();
    NativeCvmSourceFacade.watch("independent-proof",other,new NativeCvmSourceFacade.Observer(){public void completed(String permit){}public void cancel(){otherCancelled.incrementAndGet();}});
    check(CvmHostFixture.sendRequest("delivery",revision,cancelled,event()));check(CvmHostFixture.sendRequest("delivery",revision,independent,event()));check(!CvmHostFixture.sendRequest("delivery",revision,"forged",event()));CvmHostFixture.cancel(cancelled);check(!access.current());check(cancelledCallbacks.get()==1);check(other.current());check(otherCancelled.get()==0);Handler.flush();check(pushes()==1);
    NativeCvmSourceFacade.unwatch("cancel-proof");NativeCvmSourceFacade.unwatch("independent-proof");CvmHostFixture.finish(independent);Handler.flush();
    String scalar="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{\"_meta\":{\"progressToken\":\"a/b\"},\"args\":\"\\ud800\"}}";
    check(CvmHostFixture.custom("delivery","bad-operation",scalar,"tools/call","\"a/b\"")==null);
    check(CvmHostFixture.custom("delivery","bad-token",scalar,"tools/list","\"wrong\"")==null);
    check(CvmHostFixture.custom("delivery","bad-type",scalar,"tools/list","1")==null);
    String accepted=CvmHostFixture.custom("delivery","escaped-scalar",scalar,"tools/list","\"a\\/b\"");check(accepted!=null);check(new JSONObject(CvmHostFixture.take(accepted)).getString("message").equals(scalar));CvmHostFixture.cancel(accepted);Handler.flush();
    String numeric="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{\"_meta\":{\"progressToken\":7}}}";
    accepted=CvmHostFixture.custom("delivery","numeric",numeric,"tools/list","7.0");check(accepted!=null);CvmHostFixture.cancel(accepted);Handler.flush();
    check(CvmHostFixture.custom("delivery","numeric-bool",numeric,"tools/list","true")==null);
    check(CvmHostFixture.custom("delivery","response","{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}","response",null)==null);
    accepted=CvmHostFixture.custom("delivery","response","{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}","Send response",null);check(accepted!=null);CvmHostFixture.cancel(accepted);Handler.flush();
    CvmHostFixture.responses.clear();token=begin("delivery","old-queued",30000);check(CvmHostFixture.send("delivery",revision,event()));CvmHostFixture.finish(token);check(Handler.queuedCount()==2);
    CvmHostFixture.background();CvmHostFixture.foreground();check(!CvmHostFixture.currentRevision("delivery",revision));
    String fresh=begin("delivery","fresh",30000),next=CvmHostFixture.revision("delivery");check(!next.equals(revision));check(CvmHostFixture.currentRevision("delivery",next));check(!CvmHostFixture.send("delivery",revision,event()));check(CvmHostFixture.send("delivery",next,event()));
    Handler.flush();check(pushes()==1);check(CvmHostFixture.responses.stream().filter("NULL"::equals).count()==1);CvmHostFixture.closeProvider("delivery");Handler.flush();
    CvmHostFixture.responses.clear();String expiring=begin("delivery","expires",1);check(CvmHostFixture.send("delivery",next,event()));CvmHostFixture.finish(expiring);CvmHostFixture.advance(2);Handler.flush();check(pushes()==0);check(CvmHostFixture.responses.contains("NULL"));
    CvmHostFixture.responses.clear();String overflow=begin("delivery","bounded",30000);for(int n=0;n<64;n++)check(CvmHostFixture.send("delivery",next,event()));check(!CvmHostFixture.send("delivery",next,event()));check(Handler.queuedCount()==64);CvmHostFixture.closeProvider("delivery");Handler.flush();check(pushes()==0);check(CvmHostFixture.responses.stream().anyMatch(x->x.contains("session closed")));
    CvmHostFixture.responses.clear();String one=begin("delivery","queued-response1",30000);CvmHostFixture.finish(one);String two=begin("delivery","queued-response2",30000);CvmHostFixture.finish(two);String three=begin("delivery","queued-response3",30000);CvmHostFixture.finish(three);String four=begin("delivery","queued-response4",30000);CvmHostFixture.finish(four);
    check(CvmHostFixture.ingress("delivery","too-many",false,30000)==null);check(Handler.queuedCount()==4);Handler.flush();Handler.held=false;check(Handler.count()==0);CvmHostFixture.revoke("delivery");
    System.out.println("{\"checks\":"+checks+",\"scope\":\"actual host queued delivery leases: normalfinish preserves admittedprogress, exacttoken nullcancel suppresses only its events, fastresume/revision/close/deadline revoke, 64events+4responses bounded\"}");
  }
}
