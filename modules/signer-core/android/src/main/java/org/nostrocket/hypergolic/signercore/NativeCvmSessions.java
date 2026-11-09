package org.nostrocket.hypergolic.signercore;

import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import org.nostrocket.hypergolic.host.NativeCvmSourceFacade;
import org.nostrocket.hypergolic.host.NativeSignerRelay;
import java.io.IOException;
import java.net.Socket;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;

/** Native ephemeral CEP-4 session actor. No key, event signer, socket URL or decoder is exported. */
public final class NativeCvmSessions implements AutoCloseable {
  public interface Events { void message(String session,String payload); void closed(String session,String error); }
  interface Wire {void send(String value)throws Exception;String poll()throws Exception;boolean closeKnown();}
  interface Wires {Wire open(String relay,NativeSignerRelay.Control control,long deadline,NativeSignerRelay.Budget budget)throws Exception;}
  interface Codec extends AutoCloseable {String publicKey();NativeCvmEnvelope.Prepared prepare(String raw,long now,String replyTo);NativeCvmEnvelope.Decoded decode(String raw,long now);void close();}
  interface Codecs {Codec open(String provider,NativeCvmEnvelope.Authority authority);}
  private static final class Plan {
    final NativeCvmEnvelope.Prepared prepared; final String purpose;
    Plan(NativeCvmEnvelope.Prepared prepared,String purpose){this.prepared=prepared;this.purpose=purpose;}
  }
  private interface Task {void run()throws Exception;void rejected();}
  private final Map<String,Session> sessions=new LinkedHashMap<>();
  private final Events events;private final BooleanSupplier available;private final LongSupplier clock,wall;
  private final Wires wires;private final Codecs codecs;private final NativeCvmLifetime lifetime;
  private final ExecutorService workers=Executors.newFixedThreadPool(2,r->{Thread t=new Thread(r,"native-cvm");t.setDaemon(true);return t;});
  private volatile boolean closed;
  public NativeCvmSessions(Events events,BooleanSupplier available){this(events,available,SystemClock::elapsedRealtime,()->System.currentTimeMillis()/1000,
    (relay,control,deadline,budget)->{NativeSignerRelay port=NativeSignerRelay.open(relay,control,deadline,budget);return new Wire(){
      public void send(String value)throws Exception{port.send(value);}public String poll()throws Exception{return port.pollCvm();}public boolean closeKnown(){return port.closeKnown();}};},
    (provider,authority)->{NativeCvmEnvelope envelope=new NativeCvmEnvelope(provider,authority);return new Codec(){public String publicKey(){return envelope.clientPublicKey();}
      public NativeCvmEnvelope.Prepared prepare(String raw,long now,String replyTo){return envelope.prepare(raw,now,false,replyTo);}
      public NativeCvmEnvelope.Decoded decode(String raw,long now){return envelope.decode(raw,now);}public void close(){envelope.close();}};});}
  NativeCvmSessions(Events events,BooleanSupplier available,LongSupplier clock,LongSupplier wall,Wires wires,Codecs codecs){
    this.events=events;this.available=available;this.clock=clock;this.wall=wall;this.wires=wires;this.codecs=codecs;lifetime=new NativeCvmLifetime(clock);
  }
  private static IllegalStateException denied(){return new IllegalStateException("CVM session unavailable");}
  private boolean available(){try{return !closed&&available.getAsBoolean();}catch(RuntimeException unavailable){return false;}}
  public void foreground(boolean active){lifetime.foreground(active);if(!active)cancelAll();}
  public String open(String token){
    if(!available())throw denied();NativeCvmSourceFacade.Access access=NativeCvmSourceFacade.acquire(token);
    synchronized(this){
      for(Session existing:sessions.values())if(!existing.closing&&existing.access.token().equals(token)){existing.current();return existing.id;}
      if(sessions.size()>=2)throw denied();
      Session session=new Session(access);sessions.put(session.id,session);
      try{NativeCvmSourceFacade.watch(session.id,access,session);workers.execute(session::work);}catch(RuntimeException failure){session.cancel();session.workerDrained=true;session.releaseKey();session.drain();throw failure;}
      return session.id;
    }
  }
  private synchronized Session get(String id){Session s=sessions.get(id);if(s==null||s.closing)throw denied();return s;}
  public CompletableFuture<String> prepare(String id,String token,String purpose,String message,String replyTo){
    Session session=get(id);if(!session.access.token().equals(token))throw denied();CompletableFuture<String> result=new CompletableFuture<>();
    session.enqueue(new Task(){public void run()throws Exception{
      session.current();if(session.plans.size()>=4)throw denied();session.protocol.validate(purpose,message,replyTo,session.access);
      session.preparing=message;
      try{
        NativeCvmEnvelope.Prepared prepared=session.codec.prepare(message,wall.getAsLong(),replyTo);session.current();String plan=UUID.randomUUID().toString();
        session.plans.put(plan,new Plan(prepared,purpose));result.complete(new JSONObject().put("plan",plan).put("innerEventId",prepared.innerEventId).toString());
      }finally{session.preparing=null;}
    }public void rejected(){result.completeExceptionally(denied());}});return result;
  }
  public CompletableFuture<Void> commit(String id,String plan){
    Session session=get(id);CompletableFuture<Void> result=new CompletableFuture<>();session.enqueue(new Task(){public void run()throws Exception{
      session.current();Plan prepared=session.plans.remove(plan);if(prepared==null||session.acks.size()>=4)throw denied();
      String eventId=new JSONObject(prepared.prepared.wire).getString("id");if(session.acks.putIfAbsent(eventId,result)!=null)throw denied();
      session.sending=prepared;
      try{session.port.send("[\"EVENT\","+prepared.prepared.wire+"]");session.current();}
      catch(Exception|Error failure){session.acks.remove(eventId);result.completeExceptionally(denied());session.cancel();throw failure;}
      finally{session.sending=null;}
    }public void rejected(){result.completeExceptionally(denied());}});return result;
  }
  public void close(String id){Session session;synchronized(this){session=sessions.get(id);}if(session!=null)session.cancel();}
  public boolean mayDeliver(String id){try{get(id).current();return true;}catch(RuntimeException unavailable){return false;}}
  private void cancelAll(){ArrayList<Session> copy;synchronized(this){copy=new ArrayList<>(sessions.values());}for(Session session:copy)session.cancel();}
  @Override public void close(){closed=true;lifetime.close();cancelAll();workers.shutdown();}
  private final class Session implements NativeCvmSourceFacade.Observer,NativeSignerRelay.Control {
    final String id=UUID.randomUUID().toString(),subscription=UUID.randomUUID().toString();
    final NativeCvmSourceFacade.Access access;final NativeCvmLifetime.Session resource;final NativeCvmLifetime.Operation operation;
    final NativeCvmProtocol protocol;final String relay;final Codec codec;
    final java.util.ArrayDeque<Task> tasks=new java.util.ArrayDeque<>();final Map<String,Plan> plans=new LinkedHashMap<>();
    final Map<String,CompletableFuture<Void>> acks=new LinkedHashMap<>();final Set<Socket> sockets=new LinkedHashSet<>();
    volatile boolean closing,workerDrained,keyDrained,uncertain;volatile Wire port;volatile Plan sending;volatile String preparing;
    int resolutions,inbound;boolean emitted,notified,released;
    Session(NativeCvmSourceFacade.Access access){
      this.access=access;if(access.relays().isEmpty())throw denied();relay=access.relays().get(0);
      resource=lifetime.open(()->available()&&access.sourceCurrent());
      NativeCvmLifetime.Operation started;
      try{started=lifetime.begin(resource,access.deadline());}catch(RuntimeException failure){lifetime.drained(resource,true);throw failure;}
      operation=started;Codec created=null;
      try{
        created=codecs.open(access.provider(),new NativeCvmEnvelope.Authority(){public void current(){Session.this.current();}
          public void outgoing(String message,String provider){Session.this.current();if(!access.provider().equals(provider)||!message.equals(preparing))throw denied();}});
      }catch(RuntimeException|Error failure){if(created!=null)try{created.close();}catch(RuntimeException|Error unknown){lifetime.drained(resource,false);throw failure;}lifetime.drained(resource,true);throw failure;}
      codec=created;protocol=new NativeCvmProtocol(access.message());
    }
    void current(){if(closing||!available()||!access.current()||clock.getAsLong()>=access.deadline())throw denied();lifetime.current(operation);}
    synchronized void enqueue(Task task){current();if(tasks.size()>=4)throw denied();tasks.addLast(task);notifyAll();}
    void work(){
      try{
        current();port=wires.open(relay,this,access.deadline(),NativeSignerRelay.Budget.forCvm());current();
        String query=new JSONObject().put("kinds",new JSONArray().put(1059).put(21059)).put("#p",new JSONArray().put(codec.publicKey())).put("since",Math.max(0,wall.getAsLong()-172800)).put("limit",32).toString();
        port.send("[\"REQ\","+JSONObject.quote(subscription)+","+query+"]");
        while(!closing){current();Task task; synchronized(this){task=tasks.pollFirst();}
          if(task!=null){try{task.run();}catch(Exception|Error denied){task.rejected();cancel();}continue;}
          String frame=port.poll();if(frame!=null)receive(frame);
        }
      }catch(Exception|Error unavailable){cancel();}
      finally{
        cancel();Wire actual=port;port=null;
        if(actual!=null)try{if(!actual.closeKnown())uncertain=true;}catch(RuntimeException|Error unknown){uncertain=true;}
        releaseKey();ArrayList<Task> rejected; synchronized(this){rejected=new ArrayList<>(tasks);tasks.clear();}
        for(Task task:rejected)task.rejected();for(CompletableFuture<Void> waiter:acks.values())waiter.completeExceptionally(denied());acks.clear();plans.clear();
        workerDrained=true;notifyClosed();drain();
      }
    }
    void receive(String raw)throws Exception{
      current();if(++inbound>1024)throw denied();JSONArray frame=new JSONArray(raw);String type=frame.getString(0);
      if("OK".equals(type)){
        if(frame.length()!=4||!(frame.get(1)instanceof String)||!(frame.get(2)instanceof Boolean)||!(frame.get(3)instanceof String))throw denied();
        CompletableFuture<Void> waiter=acks.remove(frame.getString(1));if(waiter!=null){if(frame.getBoolean(2))waiter.complete(null);else{waiter.completeExceptionally(denied());cancel();}}return;
      }
      if("EVENT".equals(type)){
        if(frame.length()!=3||!subscription.equals(frame.get(1))||!(frame.get(2)instanceof JSONObject))throw denied();
        NativeCvmEnvelope.Decoded decoded=codec.decode(frame.getJSONObject(2).toString(),wall.getAsLong());current();protocol.receive(decoded.message);
        JSONObject value=new JSONObject().put("session",id).put("message",decoded.message).put("eventId",decoded.eventId).put("references",new JSONArray(decoded.references));
        if(decoded.paymentInteraction!=null)value.put("paymentInteraction",decoded.paymentInteraction);events.message(id,value.toString());return;
      }
      if("EOSE".equals(type)){if(frame.length()!=2||!subscription.equals(frame.get(1)))throw denied();return;}
      if("NOTICE".equals(type)){if(frame.length()!=2||!(frame.get(1)instanceof String))throw denied();return;}
      throw denied(); // AUTH/CLOSED and unknown messages do not create authentication or replay.
    }
    public boolean isCancelled(){try{current();return false;}catch(RuntimeException unavailable){return true;}}
    public void attach(Socket socket)throws IOException{synchronized(this){if(closing)throw new IOException("CVM session closed");sockets.add(socket);}if(isCancelled()){try{socket.close();}catch(IOException|RuntimeException|Error unknown){uncertain=true;}throw new IOException("CVM session closed");}}
    public void beforeSend()throws IOException{
      try{current();Plan plan=sending;if(plan!=null&&"approved".equals(plan.purpose)){
        synchronized(this){if(emitted||!access.consume(access.message(),relay))throw denied();emitted=true;}
      }}catch(RuntimeException denied){throw new IOException("CVM session unavailable");}
    }
    public boolean tracksResolution(){return true;}
    public synchronized void resolutionReserved(){resolutions++;}
    public void resolutionDrained(){synchronized(this){if(resolutions<=0){uncertain=true;return;}resolutions--;}drain();}
    public void completed(String permit){if(!access.token().equals(permit))return;try{current();lifetime.delivered(operation);}catch(RuntimeException invalid){/* retiring still revokes all effects */}cancel();}
    public void cancel(){
      synchronized(this){if(closing)return;closing=true;lifetime.cancel(resource);for(Socket socket:sockets)try{socket.close();}catch(IOException|RuntimeException|Error unknown){uncertain=true;}notifyAll();}
    }
    void releaseKey(){if(keyDrained)return;try{codec.close();keyDrained=true;}catch(RuntimeException|Error unknown){uncertain=true;}}
    synchronized void notifyClosed(){if(!notified){notified=true;try{events.closed(id,"session closed");}catch(RuntimeException|Error ignored){/* Event delivery cannot prevent native teardown. */}}}
    void drain(){boolean done;synchronized(this){done=closing&&workerDrained&&keyDrained&&resolutions==0&&!released;if(done)released=true;}
      if(!done)return;NativeCvmSourceFacade.unwatch(id);lifetime.drained(resource,!uncertain);synchronized(NativeCvmSessions.this){sessions.remove(id);}
    }
  }
}
