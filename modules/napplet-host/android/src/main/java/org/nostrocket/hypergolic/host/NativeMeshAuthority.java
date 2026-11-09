package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

/** Native-only Mesh source/permit owner. No bridge registration, key, socket or signer is installed here. */
public final class NativeMeshAuthority {
  private static final String PLACEHOLDER_SIGNATURE="00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
  public static final long JOB_MILLIS = 15_000, PAIRING_MILLIS = 120_000;
  public static final int RUNNING = 2, WAITING = 4, PUBLISH_TTL = 2, SUBSCRIBE_TTL = 1, INCOMING_TTL = 2;
  public static final String CONSENT = "Read this account's stored and live paired-circle events and repeatedly sign Mesh events as this account without a prompt for each event. Open napplets may continue while unfocused. Background, account changes, closing this napplet or revoking Mesh stops its work. Peers may keep and forward events within your hop limits.";
  public static final class Source {
    public final String endpoint, generation, user, vault, publisher, appId, version, instance;
    public final long epoch, vaultRevision, grantRevision, circleRevision;
    Source(String endpoint,String generation,String user,long epoch,String vault,long vaultRevision,String publisher,String appId,String version,String instance,long grantRevision,long circleRevision) {
      if(!handle(endpoint)||!handle(generation)||!hex(user)||!handle(vault)||!hex(publisher)||!text(appId,1024)||!hex(version)||!handle(instance)||
        !revision(epoch)||!revision(vaultRevision)||!revision(grantRevision)||!revision(circleRevision)) throw new IllegalArgumentException("Invalid Mesh source");
      this.endpoint=endpoint;this.generation=generation;this.user=user;this.epoch=epoch;this.vault=vault;this.vaultRevision=vaultRevision;
      this.publisher=publisher;this.appId=appId;this.version=version;this.instance=instance;this.grantRevision=grantRevision;this.circleRevision=circleRevision;
    }
  }
  public static final class Registration {
    private final NativeMeshAuthority owner; public final Source source;
    private long tokens=40_000, refill;
    private Registration(NativeMeshAuthority owner,Source source,long now){this.owner=owner;this.source=source;refill=now;}
  }
  private static final class EventTemplate {
    final int kind;final String content;final List<List<String>> tags;
    EventTemplate(int kind,String content,List<List<String>> tags){this.kind=kind;this.content=content;this.tags=tags;}
  }
  public static final class Publication {
    public final String requestId, user, unsigned, canonical, eventId;
    public final int kind, ttl; public final long createdAt; public final Long expiresAt;
    private Publication(String requestId,String user,EventTemplate template,int ttl,long created) {
      int kind=template.kind;String content=template.content;List<List<String>> tags=template.tags;
      if(kind<0||kind>65535||kind==22242||kind==24242||content==null||content.getBytes(StandardCharsets.UTF_8).length>8192||tags==null||tags.size()>256) throw new IllegalArgumentException("Invalid Mesh template");
      String body=quote(content);int payloadBytes=body.getBytes(StandardCharsets.UTF_8).length+2;
      Long expiration=null;List<String> encoded=new ArrayList<>();
      for(List<String> tag:tags){if(tag==null||tag.isEmpty()||tag.size()>64)throw new IllegalArgumentException("Invalid Mesh tags");payloadBytes+=2+(encoded.isEmpty()?0:1);List<String> fields=new ArrayList<>();
        if("expiration".equals(tag.get(0))){if(expiration!=null||tag.size()!=2||!tag.get(1).matches("[0-9]{1,16}"))throw new IllegalArgumentException("Invalid Mesh expiration");expiration=Long.parseLong(tag.get(1));if(!revision(expiration)||expiration<=created)throw new IllegalArgumentException("Expired Mesh event");}
        for(String field:tag){if(field==null||field.getBytes(StandardCharsets.UTF_8).length>8192)throw new IllegalArgumentException("Invalid Mesh field");String quoted=quote(field);payloadBytes+=quoted.getBytes(StandardCharsets.UTF_8).length+(fields.isEmpty()?0:1);if(payloadBytes>8192)throw new IllegalArgumentException("Mesh payload too large");fields.add(quoted);}encoded.add("["+join(fields)+"]");}
      String tagJSON="["+join(encoded)+"]";
      this.requestId=requestId;this.user=user;this.kind=kind;this.ttl=ttl;createdAt=created;expiresAt=expiration;
      canonical="[0,"+quote(user)+","+created+","+kind+","+tagJSON+","+body+"]";eventId=sha(canonical);
      unsigned="{\"pubkey\":"+quote(user)+",\"created_at\":"+created+",\"kind\":"+kind+",\"tags\":"+tagJSON+",\"content\":"+body+"}";
      String frame="[\"EVENT\",{\"id\":"+quote(eventId)+",\"pubkey\":"+quote(user)+",\"created_at\":"+created+",\"kind\":"+kind+",\"tags\":"+tagJSON+",\"content\":"+body+",\"sig\":\""+PLACEHOLDER_SIGNATURE+"\"}]";
      if(frame.getBytes(StandardCharsets.UTF_8).length>8192)throw new IllegalArgumentException("Mesh frame too large");
    }
  }
  private static final class PairParticipant {
    final String user,device,nonce;
    PairParticipant(String user,String device,String nonce){this.user=user;this.device=device;this.nonce=nonce;}
  }
  private static final class PairInvitation {
    final String id,secretHash;final long expires;
    PairInvitation(String id,String secretHash,long expires){this.id=id;this.secretHash=secretHash;this.expires=expires;}
  }
  /** Fixed native pairing transcript; no constructor accepts an arbitrary digest or body. */
  public static final class Pairing {
    public final String transcriptHex, digest, localUser, remoteUser, localDevice, remoteDevice;
    public final long expiresAt; public final boolean inviter; private final byte[] transcript;
    private Pairing(PairParticipant local,PairParticipant remote,PairInvitation invitation,boolean inviter) {
      String user=local.user,localDevice=local.device,localNonce=local.nonce,remoteUser=remote.user,remoteDevice=remote.device,remoteNonce=remote.nonce,invite=invitation.id,secretHash=invitation.secretHash;long expires=invitation.expires;
      if(!hex(localDevice)||!hex(remoteUser)||!hex(remoteDevice)||localDevice.equals(remoteDevice)||invite==null||!invite.matches("[0-9a-f]{32}")||!hex(secretHash)||!hex(localNonce)||!hex(remoteNonce)||localNonce.equals(remoteNonce))throw new IllegalArgumentException("Invalid Mesh pairing");
      this.localUser=user;this.remoteUser=remoteUser;this.localDevice=localDevice;this.remoteDevice=remoteDevice;expiresAt=expires;this.inviter=inviter;
      ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] prefix="hypergolic.mesh.pairing.v1".getBytes(StandardCharsets.US_ASCII);bytes.write(prefix,0,prefix.length);bytes.write(0);bytes.write(inviter?1:2);
      for(String field:new String[]{invite,secretHash,inviter?user:remoteUser,inviter?remoteUser:user,inviter?localDevice:remoteDevice,inviter?remoteDevice:localDevice,inviter?localNonce:remoteNonce,inviter?remoteNonce:localNonce}){
        byte[] value=decode(field);bytes.write(value,0,value.length);
      }
      byte[] expiry=ByteBuffer.allocate(8).putLong(expires).array();bytes.write(expiry,0,expiry.length);transcript=bytes.toByteArray();transcriptHex=encode(transcript);digest=sha(transcript);
    }
    public byte[] transcript(){return transcript.clone();}
  }
  /** Exact native signed wire capture; construction is restricted to this permit owner. */
  public static final class SignedPublication {
    public final Publication publication;public final String signature,event,frame;private final byte[] bytes;
    private SignedPublication(Publication capture,String signature){
      publication=capture;this.signature=signature;
      event="{\"id\":"+quote(capture.eventId)+","+capture.unsigned.substring(1,capture.unsigned.length()-1)+",\"sig\":"+quote(signature)+"}";
      frame="[\"EVENT\","+event+"]";bytes=frame.getBytes(StandardCharsets.UTF_8);if(bytes.length>8192)throw new IllegalArgumentException("Mesh frame too large");
    }
    public byte[] frameBytes(){return bytes.clone();}
  }
  /** Local role-specific proof only; not authority to persist a completed peer membership. */
  public static final class SignedPairing {
    public final Pairing pairing;public final String signature;private final byte[] binding;
    private SignedPairing(Pairing capture,String signature){pairing=capture;this.signature=signature;byte[] transcript=capture.transcript();binding=Arrays.copyOf(transcript,transcript.length+64);System.arraycopy(decode(signature),0,binding,transcript.length,64);}
    public byte[] bindingBytes(){return binding.clone();}
  }
  private static final class Grant {final long revision;final boolean enabled;Grant(long revision,boolean enabled){this.revision=revision;this.enabled=enabled;}}
  public static final class Request {private final NativeMeshAuthority owner;private Request(NativeMeshAuthority owner){this.owner=owner;}}
  private static final class Row {
    final Registration source;final Publication publication;final Pairing pairing;final long revision,deadline;boolean approved,cancelled,deliveryIssued;
    Row(Registration source,Publication publication,Pairing pairing,long revision,long deadline){this.source=source;this.publication=publication;this.pairing=pairing;this.revision=revision;this.deadline=deadline;approved=pairing==null;}
  }
  public static final class Permit {
    private final NativeMeshAuthority owner;private final Row row;private boolean begun,claimed,emitted,finished;private SignedPublication signedPublication;private SignedPairing signedPairing;
    private Permit(NativeMeshAuthority owner,Row row){this.owner=owner;this.row=row;}
    public long originalDeadline(){return row.deadline;}
    public Publication publication(){return row.publication;}
    public Pairing pairing(){return row.pairing;}
    public SignedPublication signedPublication(){synchronized(owner){return signedPublication;}}
    public SignedPairing signedPairing(){synchronized(owner){return signedPairing;}}
  }
  public static final class Delivery {private final NativeMeshAuthority owner;private final Row row;private Delivery(NativeMeshAuthority owner,Row row){this.owner=owner;this.row=row;}}
  @FunctionalInterface public interface Effect {void run();}
  @FunctionalInterface public interface PublicationEffect {void run(SignedPublication capture);}
  @FunctionalInterface public interface PairingEffect {void run(SignedPairing capture);}
  @FunctionalInterface public interface PublicationSigner {String sign(Publication capture);}
  @FunctionalInterface public interface PairingSigner {String sign(Pairing capture);}
  private final LongSupplier clock,wallSeconds;
  private final Map<String,Registration> sources=new LinkedHashMap<>();private final Map<String,Grant> grants=new LinkedHashMap<>();
  private final Map<Request,Row> waiting=new LinkedHashMap<>();private final Map<Permit,Row> running=new LinkedHashMap<>();private final Map<Delivery,Row> deliveries=new LinkedHashMap<>();
  private String user,vault;private long epoch=-1,vaultRevision=-1,circleRevision=-1,revision,last=-1;private boolean foreground,localSigner,closed,clockFailed;
  public NativeMeshAuthority(LongSupplier clock,LongSupplier wallSeconds){if(clock==null||wallSeconds==null)throw new IllegalArgumentException();this.clock=clock;this.wallSeconds=wallSeconds;}
  private static String join(List<String> values){StringBuilder result=new StringBuilder();for(String value:values){if(result.length()>0)result.append(',');result.append(value);}return result.toString();}
  private static String quote(String value){return NativeCanonicalJSON.INSTANCE.quote(value);}
  private static String sha(String value){return sha(value.getBytes(StandardCharsets.UTF_8));}
  private static String sha(byte[] value){try{return encode(MessageDigest.getInstance("SHA-256").digest(value));}catch(java.security.NoSuchAlgorithmException failure){throw new IllegalStateException(failure);}}
  private static String encode(byte[] value){StringBuilder out=new StringBuilder(value.length*2);for(byte b:value){int v=b&255;out.append("0123456789abcdef".charAt(v>>>4));out.append("0123456789abcdef".charAt(v&15));}return out.toString();}
  private static byte[] decode(String value){byte[] out=new byte[value.length()/2];for(int i=0;i<out.length;i++)out[i]=(byte)((Character.digit(value.charAt(i*2),16)<<4)|Character.digit(value.charAt(i*2+1),16));return out;}
  private static boolean hex(String value){return value!=null&&value.matches("[0-9a-f]{64}");}
  private static boolean handle(String value){return value!=null&&value.matches("[A-Za-z0-9_-]{1,80}");}
  private static boolean revision(long value){return value>=0&&value<=9_007_199_254_740_991L;}
  private static boolean text(String value,int max){return value!=null&&!value.isEmpty()&&StandardCharsets.UTF_8.newEncoder().canEncode(value)&&value.getBytes(StandardCharsets.UTF_8).length<=max&&value.chars().noneMatch(c->c<32||c==127);}
  private static String grantKey(String publisher,String appId){return sha(publisher+"\n"+appId);}
  private long time(){long now;try{now=clock.getAsLong();}catch(RuntimeException failure){now=-1;}if(now<0||now<last||now>Long.MAX_VALUE-PAIRING_MILLIS)clockFailed=true;if(!clockFailed)last=now;return last;}
  private boolean available(){return !closed&&!clockFailed&&foreground&&localSigner&&user!=null;}
  private boolean live(Registration source){if(source==null||source.owner!=this||!available()||sources.get(source.source.generation)!=source)return false;
    Source s=source.source;Grant grant=grants.get(grantKey(s.publisher,s.appId));return s.user.equals(user)&&s.epoch==epoch&&s.vault.equals(vault)&&s.vaultRevision==vaultRevision&&s.circleRevision==circleRevision&&grant!=null&&grant.enabled&&grant.revision==s.grantRevision;}
  private boolean pairingLive(Pairing pairing){if(pairing==null)return true;try{long wall=wallSeconds.getAsLong();return revision(wall)&&wall<pairing.expiresAt;}catch(RuntimeException failure){return false;}}
  private boolean eventLive(Publication event){if(event==null||event.expiresAt==null)return true;try{long wall=wallSeconds.getAsLong();return revision(wall)&&wall<event.expiresAt;}catch(RuntimeException failure){return false;}}
  private boolean live(Row row){return eventLive(row.publication)&&pairingLive(row.pairing)&&available()&&!row.cancelled&&row.revision==revision&&last<row.deadline&&(row.source==null||live(row.source));}
  private void prune(){time();waiting.entrySet().removeIf(e->!live(e.getValue()));for(Row row:running.values())if(!live(row))row.cancelled=true;deliveries.entrySet().removeIf(e->!live(e.getValue()));}
  private void invalidate(){if(revision==Long.MAX_VALUE){closed=true;}else revision++;waiting.clear();sources.clear();for(Row row:running.values())row.cancelled=true;deliveries.clear();}
  public synchronized void account(String user,long epoch,String vault,long vaultRevision,boolean selectedLocal,long circleRevision){
    if(!hex(user)||!revision(epoch)||!handle(vault)||!revision(vaultRevision)||!revision(circleRevision)){close();return;}
    if(!user.equals(this.user)||epoch!=this.epoch||!vault.equals(this.vault)||vaultRevision!=this.vaultRevision||selectedLocal!=localSigner||circleRevision!=this.circleRevision){invalidate();grants.clear();}
    this.user=user;this.epoch=epoch;this.vault=vault;this.vaultRevision=vaultRevision;localSigner=selectedLocal;this.circleRevision=circleRevision;prune();
  }
  public synchronized void grant(String publisher,String appId,long value,boolean enabled){
    prune();if(!hex(publisher)||!text(appId,1024)||!revision(value)||!available())return;String key=grantKey(publisher,appId);Grant old=grants.get(key);
    if(old!=null&&(value<old.revision||value==old.revision&&enabled&&!old.enabled))return;
    if(old==null&&grants.size()>=64)return;grants.put(key,new Grant(value,enabled));prune();
  }
  public synchronized Registration register(Source source){prune();if(source==null||!available()||sources.size()>=64||sources.containsKey(source.generation))return null;
    Registration row=new Registration(this,source,last);sources.put(source.generation,row);if(!live(row)){sources.remove(source.generation);return null;}return row;
  }
  private boolean rate(Registration source){long elapsed=last-source.refill;source.tokens=elapsed>=2000?40_000:Math.min(40_000,source.tokens+elapsed*20);source.refill=last;return source.tokens>=1000;}
  public synchronized Request admitPublication(Registration source,String id,int kind,String content,List<List<String>> tags,Integer ttl){
    prune();if(!live(source)||!text(id,128)||waiting.size()>=WAITING||ttl!=null&&(ttl<0||ttl>255)||!rate(source))return null;
    long wall;try{wall=wallSeconds.getAsLong();}catch(RuntimeException failure){return null;}if(!revision(wall))return null;
    Publication capture;try{capture=new Publication(id,user,new EventTemplate(kind,content,tags),ttl==null?PUBLISH_TTL:Math.min(ttl,PUBLISH_TTL),wall);}catch(RuntimeException failure){return null;}
    source.tokens-=1000;Request request=new Request(this);waiting.put(request,new Row(source,capture,null,revision,last+JOB_MILLIS));return request;
  }
  public synchronized Request admitPairing(String localDevice,String remoteUser,String remoteDevice,String invite,String secretHash,String localNonce,String remoteNonce,long expiresAt,boolean inviter){
    prune();if(!available()||waiting.size()>=WAITING||waiting.values().stream().anyMatch(r->r.pairing!=null)||running.values().stream().anyMatch(r->r.pairing!=null))return null;
    long wall;try{wall=wallSeconds.getAsLong();}catch(RuntimeException failure){return null;}if(!revision(wall)||expiresAt<=wall||expiresAt-wall>120)return null;
    Pairing capture;try{capture=new Pairing(new PairParticipant(user,localDevice,localNonce),new PairParticipant(remoteUser,remoteDevice,remoteNonce),new PairInvitation(invite,secretHash,expiresAt),inviter);}catch(RuntimeException failure){return null;}
    Request request=new Request(this);waiting.put(request,new Row(null,null,capture,revision,last+Math.min(PAIRING_MILLIS,(expiresAt-wall)*1000)));return request;
  }
  /** Only the exact native pairing confirmation may call this; a Mesh grant is not pairing consent. */
  public synchronized boolean approvePairing(Request request){prune();Row row=request!=null&&request.owner==this?waiting.get(request):null;if(row==null||row.pairing==null||row.approved)return false;row.approved=true;return true;}
  public synchronized Permit startNext(){prune();if(running.size()>=RUNNING)return null;for(Map.Entry<Request,Row> entry:waiting.entrySet())if(entry.getValue().approved){Row row=entry.getValue();waiting.remove(entry.getKey());Permit permit=new Permit(this,row);running.put(permit,row);return permit;}return null;}
  public synchronized boolean current(Registration source){prune();return live(source);}
  public synchronized boolean current(Permit permit){if(permit==null||permit.owner!=this)return false;prune();return !permit.finished&&running.get(permit)==permit.row&&live(permit.row);}
  /** Reserve before worker dispatch; cancellation never returns this slot until drained(). */
  public synchronized boolean begin(Permit permit){if(!current(permit)||permit.begun)return false;permit.begun=true;return true;}
  public synchronized SignedPublication signPublication(Permit permit,PublicationSigner signer){
    if(!current(permit)||!permit.begun||permit.claimed||permit.row.publication==null||signer==null)return null;permit.claimed=true;
    String signature=signer.sign(permit.row.publication);if(!current(permit)||signature==null||!signature.matches("[0-9a-f]{128}"))return null;permit.signedPublication=new SignedPublication(permit.row.publication,signature);return permit.signedPublication;
  }
  public synchronized SignedPairing signPairing(Permit permit,PairingSigner signer){
    if(!current(permit)||!permit.begun||permit.claimed||permit.row.pairing==null||signer==null)return null;permit.claimed=true;
    String signature=signer.sign(permit.row.pairing);if(!current(permit)||signature==null||!signature.matches("[0-9a-f]{128}"))return null;permit.signedPairing=new SignedPairing(permit.row.pairing,signature);return permit.signedPairing;
  }
  /** Synchronous native enqueue/store effect only; consumed before invoking it, including throws. */
  private boolean perform(Permit permit,Effect effect){if(!current(permit)||!permit.begun||(permit.signedPublication==null&&permit.signedPairing==null)||permit.emitted||effect==null)return false;permit.emitted=true;effect.run();return true;}
  public synchronized boolean performPublication(Permit permit,SignedPublication captured,byte[] frame,PublicationEffect effect){return permit!=null&&permit.owner==this&&captured!=null&&permit.signedPublication==captured&&frame!=null&&Arrays.equals(captured.bytes,frame)&&effect!=null&&perform(permit,()->effect.run(captured));}
  public synchronized boolean performPairing(Permit permit,SignedPairing captured,byte[] binding,PairingEffect effect){return permit!=null&&permit.owner==this&&captured!=null&&permit.signedPairing==captured&&binding!=null&&Arrays.equals(captured.binding,binding)&&effect!=null&&perform(permit,()->effect.run(captured));}
  public synchronized boolean emissionAttempted(Permit permit){return permit!=null&&permit.owner==this&&permit.emitted;}
  public synchronized Delivery delivery(Permit permit){if(!current(permit)||permit.row.deliveryIssued||deliveries.size()>=32)return null;permit.row.deliveryIssued=true;Delivery receipt=new Delivery(this,permit.row);deliveries.put(receipt,permit.row);return receipt;}
  public synchronized boolean deliver(Delivery receipt,Effect effect){if(receipt==null||receipt.owner!=this)return false;prune();Row row=deliveries.remove(receipt);if(row==null||!live(row)||effect==null)return false;effect.run();return true;}
  public synchronized void cancel(Request request){if(request!=null&&request.owner==this)waiting.remove(request);}
  public synchronized void cancel(Permit permit){if(permit!=null&&permit.owner==this)permit.row.cancelled=true;prune();}
  /** The owning worker calls this only from actual finally/unwind, never logical cancellation. */
  public synchronized void drained(Permit permit){if(permit!=null&&permit.owner==this&&!permit.finished){permit.finished=true;running.remove(permit);}}
  public synchronized void revoke(Registration source){if(source!=null&&source.owner==this&&sources.get(source.source.generation)==source)sources.remove(source.source.generation);prune();}
  public synchronized void circle(long value){if(!revision(value)||value<circleRevision){close();return;}if(value!=circleRevision){circleRevision=value;invalidate();}prune();}
  public synchronized void unpair(long value){if(value<=circleRevision){close();return;}circle(value);}
  public synchronized void foreground(boolean value){foreground=value;if(!value)invalidate();prune();}
  public synchronized int running(){prune();return running.size();}
  public synchronized int waiting(){prune();return waiting.size();}
  public synchronized void close(){closed=true;foreground=false;invalidate();grants.clear();}
}
