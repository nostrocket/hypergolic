package org.nostrocket.hypergolic.signercore;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

/** Actual Java CEP-4 + JNI/C signer and NIP44, new in-memory test keys only. */
public final class CvmEnvelopeRuntimeProof {
  private static int checks;
  private static void check(boolean value){if(!value)throw new AssertionError("envelope "+checks);checks++;}
  private static void denied(Runnable body){try{body.run();throw new AssertionError("Expected envelope denial");}catch(RuntimeException expected){checks++;}}
  private static String signed(NativeSigningKey key,long now,int kind,String recipient,String message,String reference){
    String tags="[[\"p\","+NativeEvent.quote(recipient)+"]"+(reference==null?"":",[\"e\","+NativeEvent.quote(reference)+"]")+"]";
    NativeEvent event=NativeEvent.capture("{\"pubkey\":"+NativeEvent.quote(key.publicKey())+",\"created_at\":"+now+",\"kind\":"+kind+",\"tags\":"+tags+",\"content\":"+NativeEvent.quote(message)+"}",key.publicKey(),65536);
    return event.signed(key.sign(event.digest));
  }
  private static String wrap(String recipient,String inner,long now,int kind){
    try(NativeSigningKey wrapping=new NativeSigningKey()){
      byte[] ciphertext=wrapping.transport(recipient,inner.getBytes(StandardCharsets.UTF_8),true);
      try{return signed(wrapping,now,kind,recipient,new String(ciphertext,StandardCharsets.UTF_8),null);}finally{java.util.Arrays.fill(ciphertext,(byte)0);}
    }
  }
  public static void main(String[]args)throws Exception{
    AtomicBoolean current=new AtomicBoolean(true);String request="{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"number\":-1.25,\"opaque\":\"\\ud800\"}}";long now=1700000000;
    try(NativeSigningKey provider=new NativeSigningKey();NativeSigningKey foreign=new NativeSigningKey();NativeCvmEnvelope client=new NativeCvmEnvelope(provider.publicKey(),new NativeCvmEnvelope.Authority(){
      public void current(){if(!current.get())throw new IllegalStateException("closed fixture");}public void outgoing(String message,String recipient){check(request.equals(message));check(provider.publicKey().equals(recipient));}})){
      String clientKey=client.clientPublicKey();
      // Separate native contexts cannot inherit another client's paid authorization identity.
      try(NativeCvmEnvelope independent=new NativeCvmEnvelope(provider.publicKey(),new NativeCvmEnvelope.Authority(){
        public void current(){if(!current.get())throw new IllegalStateException("closed fixture");}
        public void outgoing(String message,String recipient){throw new AssertionError("No independent send");}})){
        check(NativeSigningKey.validPublicKey(independent.clientPublicKey()));check(!clientKey.equals(independent.clientPublicKey()));
      }
      NativeCvmEnvelope.Prepared prepared=client.prepare(request,now,false,null);JSONObject outer=new JSONObject(prepared.wire);
      check(outer.getInt("kind")==1059);check(outer.getLong("created_at")==now);NativeSignedEvent.verify(outer,outer.getString("pubkey"),65536);checks++;
      byte[] clear=provider.transport(outer.getString("pubkey"),outer.getString("content").getBytes(StandardCharsets.UTF_8),false);
      JSONObject inner;
      try{inner=new JSONObject(new String(clear,StandardCharsets.UTF_8));}finally{java.util.Arrays.fill(clear,(byte)0);}
      check(inner.getInt("kind")==25910);check(inner.getString("pubkey").equals(clientKey));check(inner.getString("id").equals(prepared.innerEventId));
      NativeSignedEvent.verify(inner,clientKey,65536);checks++;check(inner.getString("content").equals(request));
      // Exact first-message tags exclude mode, PMI and direct-payment authority.
      check(inner.getJSONArray("tags").toString().equals("[[\"p\",\""+provider.publicKey()+"\"],[\"support_encryption\"],[\"support_open_stream\"]]"));
      check(outer.getJSONArray("tags").toString().equals("[[\"p\",\""+provider.publicKey()+"\"]]"));
      NativeCvmEnvelope.Prepared referenced=client.prepare(request,now,false,"3".repeat(64));JSONObject secondOuter=new JSONObject(referenced.wire);
      check(secondOuter.getLong("created_at")==now);
      JSONObject ephemeralOuter=new JSONObject(client.prepare(request,now,true,null).wire);
      check(ephemeralOuter.getInt("kind")==21059&&ephemeralOuter.getLong("created_at")==now);
      // ContextVM reference servers subscribe with since equal to their startup second.
      check(outer.getLong("created_at")>=now&&ephemeralOuter.getLong("created_at")>=now);
      byte[] secondClear=provider.transport(secondOuter.getString("pubkey"),secondOuter.getString("content").getBytes(StandardCharsets.UTF_8),false);
      try{check(new JSONObject(new String(secondClear,StandardCharsets.UTF_8)).getJSONArray("tags").toString().equals("[[\"p\",\""+provider.publicKey()+"\"],[\"e\",\""+"3".repeat(64)+"\"]]"));}finally{java.util.Arrays.fill(secondClear,(byte)0);}
      String response="{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}";
      String signed=signed(provider,now,25910,clientKey,response,prepared.innerEventId);NativeCvmEnvelope.Decoded decoded=client.decode(wrap(clientKey,signed,now-60,1059),now);
      check(response.equals(decoded.message));check(decoded.references.contains(prepared.innerEventId));check(decoded.eventId.matches("[0-9a-f]{64}"));
      check(response.equals(client.decode(wrap(clientKey,signed,now,21059),now).message));
      denied(()->client.decode(wrap(clientKey,signed(foreign,now,25910,clientKey,response,prepared.innerEventId),now,1059),now));
      denied(()->client.decode(wrap(clientKey,signed(provider,now,25910,foreign.publicKey(),response,prepared.innerEventId),now,1059),now));
      denied(()->client.decode(wrap(clientKey,signed,now+31,1059),now));
      denied(()->client.decode(wrap(clientKey,signed(provider,now-121,25910,clientKey,response,prepared.innerEventId),now,1059),now));
      denied(()->client.decode(wrap(clientKey,signed,now,1),now));
      current.set(false);denied(()->client.prepare(request,now,false,null));denied(client::clientPublicKey);
    }
    System.out.println("{\"checks\":"+checks+",\"scope\":\"actual Java Envelope/NIP44+freshlybuilt JNI/C, generated in-memory test keys only; no vault/provider/device\"}");
  }
}
