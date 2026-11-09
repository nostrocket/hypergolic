package org.nostrocket.hypergolic.signercore;

import org.json.JSONArray;
import org.json.JSONObject;
import org.nostrocket.hypergolic.host.CvmHostFixture;
import org.nostrocket.hypergolic.host.NativeCvmSourceFacade;
import org.nostrocket.hypergolic.host.NativeSignerRelay;
import org.nostrocket.hypergolic.host.NativeApprovalAuthority;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

/** Actual Android host+actor/protocol/lifetime; controlled codec/WSS seams, no real provider/key. */
public final class NativeCvmComposedProof {
  private static int checks;
  private static synchronized void check(boolean value){if(!value)throw new AssertionError("check "+checks);checks++;}
  private static void rejects(Runnable task){try{task.run();throw new AssertionError("Expected denial");}catch(IllegalStateException expected){checks++;}}
  private static void eventually(BooleanSupplier value)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);while(!value.getAsBoolean()&&System.nanoTime()<end)Thread.sleep(2);check(value.getAsBoolean());}
  private static String token(String generation,String id,boolean init)throws Exception{String token=CvmHostFixture.ingress(generation,id,init,30000);check(token!=null);check(CvmHostFixture.take(token)!=null);check(token.equals(CvmHostFixture.approve(token)));return token;}
  private static class Port implements NativeCvmSessions.Wire {
    final NativeSignerRelay.Control control;final LinkedBlockingQueue<String> incoming=new LinkedBlockingQueue<>();final AtomicInteger sent=new AtomicInteger();volatile String subscription;volatile boolean closed;
    Port(NativeSignerRelay.Control control){this.control=control;}
    public void send(String value)throws Exception{control.beforeSend();if(control.isCancelled())throw new java.io.IOException("cancelled");JSONArray frame=new JSONArray(value);
      if("REQ".equals(frame.getString(0))){subscription=frame.getString(1);return;}
      check("EVENT".equals(frame.getString(0)));sent.incrementAndGet();String id=frame.getJSONObject(1).getString("id");incoming.add(new JSONArray().put("OK").put(id).put(true).put("").toString());}
    public String poll()throws Exception{if(control.isCancelled())throw new java.io.IOException("cancelled");return incoming.poll(3,TimeUnit.MILLISECONDS);}
    public boolean closeKnown(){closed=true;return true;}
  }
  private static NativeCvmSessions.Codecs codecs(AtomicInteger disposed){return(provider,authority)->new NativeCvmSessions.Codec(){
    public String publicKey(){authority.current();return "e".repeat(64);}
    public NativeCvmEnvelope.Prepared prepare(String raw,long now,String replyTo){authority.current();authority.outgoing(raw,provider);
      try{var constructor=NativeCvmEnvelope.Prepared.class.getDeclaredConstructor(String.class,String.class);constructor.setAccessible(true);return constructor.newInstance("{\"id\":\""+"f".repeat(64)+"\"}","1".repeat(64));}catch(ReflectiveOperationException failure){throw new IllegalStateException(failure);}}
    public NativeCvmEnvelope.Decoded decode(String raw,long now){authority.current();return new NativeCvmEnvelope.Decoded(raw,"2".repeat(64),Collections.singletonList("1".repeat(64)),null);}
    public void close(){disposed.incrementAndGet();}
  };}
  private static void uncertainProof()throws Exception{
    CvmHostFixture.setup();check(CvmHostFixture.register("uncertain-a",true,true));check(CvmHostFixture.register("uncertain-b",true,true));
    AtomicInteger closes=new AtomicInteger();NativeCvmSessions.Codecs safe=codecs(new AtomicInteger());
    NativeCvmSessions.Codecs uncertain=(provider,authority)->{NativeCvmSessions.Codec codec=safe.open(provider,authority);return new NativeCvmSessions.Codec(){
      public String publicKey(){return codec.publicKey();}public NativeCvmEnvelope.Prepared prepare(String raw,long now,String replyTo){return codec.prepare(raw,now,replyTo);}
      public NativeCvmEnvelope.Decoded decode(String raw,long now){return codec.decode(raw,now);}public void close(){closes.incrementAndGet();throw new IllegalStateException("uncertain fixture teardown");}};};
    var actor=new NativeCvmSessions(new NativeCvmSessions.Events(){public void message(String id,String value){}public void closed(String id,String error){}},()->true,()->android.os.SystemClock.time,()->1700000000L,
      (relay,control,deadline,budget)->new Port(control),uncertain);actor.foreground(true);
    String first=token("uncertain-a","uncertain1",false),second=token("uncertain-b","uncertain2",false);String a=actor.open(first),b=actor.open(second);
    actor.close(a);actor.close(b);CvmHostFixture.closeProvider("uncertain-a");CvmHostFixture.closeProvider("uncertain-b");eventually(()->closes.get()==2);
    String third=token("uncertain-a","uncertain3",false);rejects(()->actor.open(third));rejects(()->actor.open(third));check(!actor.mayDeliver(a)&&!actor.mayDeliver(b));actor.close();
    System.out.println("{\"checks\":"+checks+",\"scope\":\"actual actor key-teardown uncertainty stays sticky; logicalclose never frees either native reservation\"}");
  }
  private static void admissionRaceProof()throws Exception{
    CvmHostFixture.setup();check(CvmHostFixture.register("queue-race",true,true));String token=token("queue-race","race",false);
    CountDownLatch admission=new CountDownLatch(1),resume=new CountDownLatch(1),failed=new CountDownLatch(1),polling=new CountDownLatch(1),failPort=new CountDownLatch(1);AtomicBoolean gate=new AtomicBoolean(true),firstWire=new AtomicBoolean(true);AtomicInteger disposed=new AtomicInteger(),closed=new AtomicInteger();
    java.util.concurrent.atomic.AtomicReference<Port> port=new java.util.concurrent.atomic.AtomicReference<>();
    BooleanSupplier available=()->{if(Thread.currentThread().getName().equals("cvm-enqueue-proof")&&gate.compareAndSet(true,false)){admission.countDown();try{resume.await();}catch(InterruptedException interrupted){Thread.currentThread().interrupt();return false;}}return true;};
    var actor=new NativeCvmSessions(new NativeCvmSessions.Events(){public void message(String id,String raw){}public void closed(String id,String error){closed.incrementAndGet();throw new IllegalStateException("observer fixture");}},available,()->android.os.SystemClock.time,()->1700000000L,
      (relay,control,deadline,budget)->{boolean initial=firstWire.compareAndSet(true,false);Port value=new Port(control){public String poll()throws Exception{if(initial){polling.countDown();failPort.await();failed.countDown();throw new java.io.IOException("fixture failure");}return super.poll();}};port.set(value);return value;},codecs(disposed));actor.foreground(true);String session=actor.open(token);eventually(()->port.get()!=null&&port.get().subscription!=null);check(polling.await(2,TimeUnit.SECONDS));
    java.util.concurrent.atomic.AtomicReference<CompletableFuture<String>> result=new java.util.concurrent.atomic.AtomicReference<>();Thread enqueue=new Thread(()->result.set(actor.prepare(session,token,"approved",CvmHostFixture.REQUEST,null)),"cvm-enqueue-proof");enqueue.setDaemon(true);enqueue.start();check(admission.await(2,TimeUnit.SECONDS));failPort.countDown();check(failed.await(2,TimeUnit.SECONDS));resume.countDown();enqueue.join(2000);check(!enqueue.isAlive());
    try{result.get().get(2,TimeUnit.SECONDS);throw new AssertionError("orphan or late prepare");}catch(java.util.concurrent.ExecutionException expected){checks++;}
    eventually(()->disposed.get()==1&&closed.get()==1);check(port.get().sent.get()==0);CvmHostFixture.closeProvider("queue-race");
    String next=token("queue-race","after-race",false);java.util.concurrent.atomic.AtomicReference<String> opened=new java.util.concurrent.atomic.AtomicReference<>();eventually(()->{try{opened.set(actor.open(next));return true;}catch(IllegalStateException draining){return false;}});actor.close(opened.get());eventually(()->disposed.get()==2);CvmHostFixture.reject(next);actor.close();check(android.os.Handler.count()==0);
    System.out.println("{\"checks\":"+checks+",\"scope\":\"actual enqueue-vs-workerfailure race settles queuedfuture with zero effects; throwingclosedobserver cannot block drain\"}");
  }
  public static void main(String[]args)throws Exception{
    if(args.length==1&&"admission-race".equals(args[0])){admissionRaceProof();return;}
    if(args.length==1&&"uncertain".equals(args[0])){uncertainProof();return;}
    CvmHostFixture.setup();check(!CvmHostFixture.register("nogrant",true,false));check(!CvmHostFixture.register("noprofile",false,true));
    check(CvmHostFixture.register("a",true,true));check(CvmHostFixture.register("b",true,true));
    check(CvmHostFixture.unsupported("a","cvm.registry.has").contains("\"has\":false"));check(CvmHostFixture.unsupported("a","cvm.discover").contains("unsupported method"));
    String first=CvmHostFixture.ingress("a","first",false,30000),second=CvmHostFixture.ingress("b","second",false,30000);check(first!=null&&second!=null);
    rejects(()->NativeCvmSourceFacade.acquire(first));check(CvmHostFixture.take(second)!=null);check(CvmHostFixture.take(first)!=null);check(CvmHostFixture.take(first)==null);check(CvmHostFixture.approve(second)==null);check(first.equals(CvmHostFixture.approve(first)));check(second.equals(CvmHostFixture.approve(second)));
    check(CvmHostFixture.approve(first)==null);
    var ports=Collections.synchronizedList(new ArrayList<Port>());AtomicInteger disposed=new AtomicInteger(),closed=new AtomicInteger();AtomicBoolean active=new AtomicBoolean(true);
    var actor=new NativeCvmSessions(new NativeCvmSessions.Events(){public void message(String id,String raw){}public void closed(String id,String error){closed.incrementAndGet();}},active::get,()->android.os.SystemClock.time,()->1700000000L,
      (relay,control,deadline,budget)->{Port port=new Port(control);ports.add(port);return port;},codecs(disposed));actor.foreground(true);
    String a=actor.open(first),b=actor.open(second);eventually(()->ports.size()==2);check(!a.equals(b));
    // Ordinary exact signing focus still revokes its authority; CVM's paired service remains live.
    var approval=new NativeApprovalAuthority(()->android.os.SystemClock.time);var focused=approval.register("ordinary-a");var other=approval.register("ordinary-b");approval.setForeground(true);approval.setFocused(focused);var review=approval.admit(focused,"owned exact snapshot");var approved=approval.approve(review);check(approval.isApproved(approved));approval.setFocused(other);check(!approval.isApproved(approved));check(actor.mayDeliver(a)&&actor.mayDeliver(b));
    rejects(()->actor.prepare(a,second,"approved",CvmHostFixture.REQUEST,null));
    String plan=new JSONObject(actor.prepare(a,first,"approved",CvmHostFixture.REQUEST,null).get(2,TimeUnit.SECONDS)).getString("plan");
    actor.commit(a,plan).get(2,TimeUnit.SECONDS);eventually(()->ports.stream().mapToInt(p->p.sent.get()).sum()==1);
    CompletableFuture<Void> replay=actor.commit(a,plan);try{replay.get(2,TimeUnit.SECONDS);throw new AssertionError("replayed");}catch(java.util.concurrent.ExecutionException expected){checks++;}
    eventually(()->disposed.get()>=1);CvmHostFixture.finish(first);
    check(actor.mayDeliver(b));CvmHostFixture.closeProvider("b");eventually(()->disposed.get()==2);check(!actor.mayDeliver(b));
    CvmHostFixture.background();CvmHostFixture.foreground();check(!CvmHostFixture.current("a"));rejects(()->actor.open(second));
    String denied=CvmHostFixture.ingress("a","denied",false,30000);check(CvmHostFixture.take(denied)!=null);CvmHostFixture.reject(denied);check(CvmHostFixture.approve(denied)==null);
    String shortRequest=CvmHostFixture.ingress("a","deadline",false,1);check(shortRequest!=null);CvmHostFixture.advance(2);check(CvmHostFixture.take(shortRequest)==null&&CvmHostFixture.approve(shortRequest)==null);
    String protocolToken=token("a","protocol",true);var access=NativeCvmSourceFacade.acquire(protocolToken);var protocol=new NativeCvmProtocol(CvmHostFixture.REQUEST);
    protocol.validate("approved",CvmHostFixture.REQUEST,null,access);checks++;rejects(()->protocol.validate("approved",CvmHostFixture.REQUEST+" ",null,access));rejects(()->protocol.validate("sign","{}",null,access));
    String initialize="{\"jsonrpc\":\"2.0\",\"id\":\"hypergolic:init:00000000-0000-4000-8000-000000000001\",\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"Hypergolic\",\"version\":\"1\"}}}";
    rejects(()->protocol.validate("initialize",initialize.replace("hypergolic:init:00000000-0000-4000-8000-000000000001","hypergolic:init"),null,access));
    rejects(()->protocol.validate("initialize",initialize.replace("hypergolic:init:00000000-0000-4000-8000-000000000001","hypergolic:init:not-a-uuid"),null,access));
    protocol.validate("initialize",initialize,null,access);checks++;rejects(()->protocol.validate("initialize",initialize,null,access));rejects(()->protocol.validate("initialized","{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}",null,access));protocol.receive("{\"jsonrpc\":\"2.0\",\"id\":\"hypergolic:init:00000000-0000-4000-8000-000000000002\",\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{}}}");rejects(()->protocol.validate("initialized","{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}",null,access));protocol.receive("{\"jsonrpc\":\"2.0\",\"id\":\"hypergolic:init:00000000-0000-4000-8000-000000000001\",\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{}}}");protocol.validate("initialized","{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}",null,access);checks++;CvmHostFixture.reject(protocolToken);
    // Actual source close/background cannot free an uncooperative resolver/worker reservation.
    CountDownLatch release=new CountDownLatch(1),entered=new CountDownLatch(2);AtomicInteger rawDisposed=new AtomicInteger(),effects=new AtomicInteger();
    var hanging=new NativeCvmSessions(new NativeCvmSessions.Events(){public void message(String id,String raw){}public void closed(String id,String error){}},active::get,()->android.os.SystemClock.time,()->1700000000L,
      (relay,control,deadline,budget)->{control.resolutionReserved();entered.countDown();try{release.await();}finally{control.resolutionDrained();}Port port=new Port(control){public void send(String value)throws Exception{effects.incrementAndGet();super.send(value);}};return port;},codecs(rawDisposed));hanging.foreground(true);
    String t1=token("a","hang-a",false),t2=token("b","hang-b",false),s1=hanging.open(t1),s2=hanging.open(t2);check(entered.await(2,TimeUnit.SECONDS));
    CompletableFuture<String> queued=hanging.prepare(s1,t1,"approved",CvmHostFixture.REQUEST,null);hanging.close(s1);hanging.close(s2);CvmHostFixture.closeProvider("a");CvmHostFixture.closeProvider("b");
    String third=token("a","third",false);rejects(()->hanging.open(third));check(!queued.isDone());check(rawDisposed.get()==0);check(effects.get()==0);release.countDown();eventually(()->rawDisposed.get()==2);try{queued.get(2,TimeUnit.SECONDS);throw new AssertionError("stale queued prepare");}catch(java.util.concurrent.ExecutionException expected){checks++;}
    check(effects.get()==0);java.util.concurrent.atomic.AtomicReference<String> fresh=new java.util.concurrent.atomic.AtomicReference<>();eventually(()->{try{fresh.set(hanging.open(third));return true;}catch(IllegalStateException waiting){return false;}});hanging.close(fresh.get());eventually(()->rawDisposed.get()==3);CvmHostFixture.reject(third);hanging.close();actor.close();check(android.os.Handler.count()==0);
    System.out.println("{\"checks\":"+checks+",\"scope\":\"actual host ingress/config/permit/actor/protocol/lifetime compiled composition; controlled codec/WSS, no provider/key/device\"}");
  }
}
