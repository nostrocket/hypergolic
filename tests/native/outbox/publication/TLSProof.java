package org.nostrocket.hypergolic.host;
import org.json.JSONObject;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Actual native plan, approval emission gate, TLS writer and ACK parser; host-only loopback policy. */
public final class TLSProof {
 public static void main(String[] args) throws Exception {
  String mode=args[3];JSONObject fixture=new JSONObject(Files.readString(Path.of(args[4])));
  String snapshot=fixture.getString("snapshot");NativeOutboxPlan plan=NativeOutboxPlan.Companion.capture(snapshot,fixture.getJSONObject("plan").toString());
  ApprovalLeaseRegistry registry=new ApprovalLeaseRegistry(()->TimeUnit.NANOSECONDS.toMillis(System.nanoTime()));
  if(!registry.register("owner-a"))throw new AssertionError();registry.foreground(true);registry.focus("owner-a",true);
  String token=registry.admit("owner-a",snapshot,true);registry.take(token);
  if(!registry.prepare(token,plan)||!registry.approve(token))throw new AssertionError();
  NativeOutboxPlan.Send send=plan.reserve("primary",fixture.getJSONObject("primary").toString(),plan.getDestinations().get(0),0);
  OutboxAcknowledgement ack=new OutboxAcknowledgement(send.getEventId());
  PublishedRelayWssQuery.PublicationControl control=new PublishedRelayWssQuery.PublicationControl(){
   @Override public boolean isCancelled(){return false;}
   @Override public void send(PublishedRelayWssQuery.SendAction emit) throws IOException {
    if(mode.equals("revoke-before-send"))registry.foreground(false);
    registry.performApproved(token,()->{send.setAttempted(true);emit.run();});
   }
  };
  PublishedHttpsTransport.AddressPolicy policy=new PublishedHttpsTransport.AddressPolicy(){
   @Override public boolean isAllowedHost(String host){return host.equals("relay.example.org");}
   @Override public boolean isAllowedAddress(InetAddress address){return address.isLoopbackAddress();}
  };
  ThreadPoolExecutor dns=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(4));
  try {
   try{PublishedRelayWssQuery.queryWithTransport("wss://relay.example.org:"+args[0]+"/fixture",send.getFrame(),policy,control,ack::classify,
     host->new InetAddress[]{InetAddress.getByAddress(new byte[]{127,0,0,1})},dns,PublishedHttpsTlsProof.trustedFactory(Path.of(args[1])),PublishedHttpsTlsProof.PROOF_HOSTNAME_VERIFIER);}catch(IOException expected){/* Actual receipt state is asserted below. */}
  }finally{dns.shutdownNow();if(!dns.awaitTermination(2,TimeUnit.SECONDS))throw new AssertionError();}
  Boolean accepted=ack.getResult()==null?null:ack.getResult().getAccepted();
  if(send.getAttempted()!=!mode.equals("revoke-before-send"))throw new AssertionError("Wrong emission state");
  Boolean expected=mode.equals("accepted")||mode.equals("accepted-close")?Boolean.TRUE:mode.equals("rejected")?Boolean.FALSE:null;
  if(!java.util.Objects.equals(accepted,expected))throw new AssertionError("Wrong ACK");
  System.out.println(new JSONObject().put("mode",mode).put("attempted",send.getAttempted()).put("ack",accepted==null?JSONObject.NULL:accepted).put("eventId",send.getEventId()).put("status","passed"));
 }
}
