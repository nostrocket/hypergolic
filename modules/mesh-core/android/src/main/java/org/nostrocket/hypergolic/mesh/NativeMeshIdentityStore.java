package org.nostrocket.hypergolic.mesh;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Native-only credential/pair store. No bridge, signer, socket or membership proof factory. */
final class NativeMeshIdentityStore implements AutoCloseable {
  static final int MAX_BYTES=131072, MAX_DEVICES=32, MAX_ACCOUNTS=16, DER_MAX=2048;
  private static final byte[] MAGIC={'H','G','M','I',1};
  private static final byte[] PAIR_PREFIX="hypergolic.mesh.pairing.v1\0".getBytes(StandardCharsets.US_ASCII);
  interface Current { boolean current(); }
  /** Only the actual native selected-account coordinator may mint this lease. */
  static final class AccountLease {
    final String account;final long epoch,vaultRevision;private final Current current;private final java.util.concurrent.atomic.AtomicBoolean revoked=new java.util.concurrent.atomic.AtomicBoolean();
    AccountLease(String account,long epoch,long vaultRevision,Current current){
      if(!hex(account)||!revision(epoch)||!revision(vaultRevision)||current==null)throw new Failure();
      this.account=account;this.epoch=epoch;this.vaultRevision=vaultRevision;this.current=current;
    }
    boolean isCurrent(){try{return !revoked.get()&&current.current()&&!revoked.get();}catch(RuntimeException failure){return false;}}
    void revoke(){revoked.set(true);}
    boolean live(){return isCurrent();}
  }
  interface Backend { byte[] read(); void write(byte[] clear,boolean initialize); }
  /** The import implementation must call the actual native TLS DER importer synchronously. */
  interface CredentialPort { Credential importDER(byte[] key,byte[] certificate); }
  interface Credential extends AutoCloseable { byte[] pin(); @Override void close(); }
  interface CredentialUse { void use(Credential nativeCredential); }
  interface CredentialBorrow extends Credential { void withNative(CredentialUse use); }
  interface CredentialSink { void capture(byte[] key,byte[] certificate); }
  interface CredentialProducer { void store(CredentialSink sink); }
  /** Native coordinator verifies both signatures/confirmations and fresh mTLS before minting. */
  static final class VerifiedMembershipCommit {
    final AccountLease lease;private final long circle;private final byte[] local,remote;private final Current proof;private boolean used;
    VerifiedMembershipCommit(AccountLease lease,long circle,byte[] local,byte[] remote,Current proof){
      if(lease==null||!revision(circle)||local==null||remote==null||local.length!=340||remote.length!=340||proof==null)throw new Failure();
      this.lease=lease;this.circle=circle;this.local=local.clone();this.remote=remote.clone();this.proof=proof;
    }
    private synchronized boolean take(AccountLease owner,long expectedCircle){if(used)return false;used=true;try{return lease==owner&&circle==expectedCircle&&owner.live()&&proof.current();}catch(RuntimeException failure){return false;}}
  }
  /** A distinct native bilateral-completion proof. It never re-signs a pending pairing. */
  static final class MembershipPromotion {
    final AccountLease lease;private final long circle;private final byte[] id,digest;private final Current proof;private boolean used;
    MembershipPromotion(AccountLease lease,long circle,byte[] pairingId,byte[] bindingsDigest,Current proof){
      if(lease==null||!revision(circle)||pairingId==null||pairingId.length!=16||bindingsDigest==null||bindingsDigest.length!=32||proof==null)throw new Failure();
      this.lease=lease;this.circle=circle;id=pairingId.clone();digest=bindingsDigest.clone();this.proof=proof;
    }
    private synchronized boolean take(AccountLease owner,long expectedCircle){if(used)return false;used=true;try{return lease==owner&&circle==expectedCircle&&owner.live()&&proof.current();}catch(RuntimeException failure){return false;}}
  }
  static final class Failure extends RuntimeException { private static final long serialVersionUID=1L;Failure(){super("Mesh identity unavailable");} }
  static final class Peer {
    final String account,pin,pairingId,bindingsDigest;final boolean active;
    Peer(Record row){account=row.account;pin=encode(row.pin);pairingId=encode(row.id);bindingsDigest=encode(row.digest);active=row.active;}
  }
  static final class View {
    final long generation,circleRevision;final String localPin;private final List<Peer> peers;
    View(Snapshot s){generation=s.generation;circleRevision=s.circle;localPin=encode(s.pin);peers=new ArrayList<>();for(Record row:s.records)peers.add(new Peer(row));}
    List<Peer> peers(){return new ArrayList<>(peers);}
    int activeAccounts(){Set<String> accounts=new HashSet<>();for(Peer p:peers)if(p.active)accounts.add(p.account);return accounts.size();}
  }
  private static final class Record {
    final byte[] local,remote,id,pin,digest;final String account;boolean active;
    Record(byte[] local,byte[] remote,boolean active,String owner,byte[] localPin){
      if(local.length!=340||remote.length!=340||!Arrays.equals(Arrays.copyOf(local,27),PAIR_PREFIX)||!Arrays.equals(Arrays.copyOf(remote,27),PAIR_PREFIX))throw new Failure();
      int role=local[27];if((role!=1&&role!=2)||remote[27]!=(role==1?2:1))throw new Failure();
      for(int i=0;i<276;i++)if(i!=27&&local[i]!=remote[i])throw new Failure();
      byte[] user=Arrays.copyOfRange(local,role==1?76:108,role==1?108:140);
      byte[] ownPin=Arrays.copyOfRange(local,role==1?140:172,role==1?172:204);
      if(!encode(user).equals(owner)||!Arrays.equals(ownPin,localPin))throw new Failure();
      pin=Arrays.copyOfRange(local,role==1?172:140,role==1?204:172);
      if(Arrays.equals(pin,localPin)||Arrays.equals(Arrays.copyOfRange(local,204,236),Arrays.copyOfRange(local,236,268)))throw new Failure();
      account=encode(Arrays.copyOfRange(local,role==1?108:76,role==1?140:108));id=Arrays.copyOfRange(local,28,44);
      // Expired invitations can still identify an already completed persistent pair.
      long expiry=0;for(int i=268;i<276;i++)expiry=(expiry<<8)|(local[i]&255L);if(!revision(expiry)||expiry==0)throw new Failure();
      this.local=local.clone();this.remote=remote.clone();this.active=active;digest=sha(concat(local,remote));
    }
    boolean same(Record other){return Arrays.equals(local,other.local)&&Arrays.equals(remote,other.remote);}
  }
  private static final class Snapshot {
    final String account;long generation,circle;byte[] key,certificate,pin;final List<Record> records=new ArrayList<>();
    Snapshot(String account,long generation,long circle,byte[] key,byte[] cert,byte[] pin){this.account=account;this.generation=generation;this.circle=circle;this.key=key.clone();certificate=cert.clone();this.pin=pin.clone();}
    void wipe(){Arrays.fill(key,(byte)0);Arrays.fill(certificate,(byte)0);}
  }
  private static final Set<String> OPEN_ACCOUNTS=new HashSet<>();
  private final AccountLease lease;private final Backend backend;private final CredentialPort port;private final Runnable revoke;
  private Snapshot snapshot;private boolean closed,registered;
  private Credential heldCredential;private int borrows,nativeCalls;
  NativeMeshIdentityStore(AccountLease lease,Backend backend,CredentialPort port,Runnable revoke){
    if(lease==null||backend==null||port==null||revoke==null)throw new Failure();this.lease=lease;this.backend=backend;this.port=port;this.revoke=revoke;
    byte[] clear=null;try{synchronized(OPEN_ACCOUNTS){if(OPEN_ACCOUNTS.size()>=16||!OPEN_ACCOUNTS.add(lease.account))throw new Failure();registered=true;}active();clear=backend.read();active();if(clear!=null){snapshot=decode(clear,lease.account);checkCredential(snapshot);active();}}
    catch(RuntimeException failure){close();throw new Failure();}finally{wipe(clear);}
  }
  private void active(){if(closed||!lease.live()||closed){close();throw new Failure();}}
  private void expected(long generation){active();if(snapshot==null||snapshot.generation!=generation)throw new Failure();}
  synchronized View view(){active();if(snapshot==null)throw new Failure();return new View(snapshot);}
  synchronized void initialize(CredentialProducer producer){
    active();if(snapshot!=null||producer==null)throw new Failure();final byte[][] capture=new byte[2][];final int[] calls={0};
    try{producer.store((key,cert)->{if(++calls[0]!=1||key==null||cert==null||key.length<1||key.length>DER_MAX||cert.length<1||cert.length>DER_MAX)throw new Failure();capture[0]=key.clone();capture[1]=cert.clone();});active();if(calls[0]!=1||capture[0]==null)throw new Failure();
      Credential credential=port.importDER(capture[0],capture[1]);if(credential==null)throw new Failure();byte[] pin;try{pin=credential.pin();}finally{credential.close();}if(pin==null||pin.length!=32)throw new Failure();
      Snapshot next=new Snapshot(lease.account,1,0,capture[0],capture[1],pin);persist(next,true);
    }finally{wipe(capture[0]);wipe(capture[1]);}
  }
  synchronized CredentialBorrow withCredential(){
    active();if(snapshot==null||borrows>=4)throw new Failure();
    if(heldCredential==null){byte[] key=snapshot.key.clone(),cert=snapshot.certificate.clone();Credential imported=null;
      try{imported=port.importDER(key,cert);active();if(imported==null||!Arrays.equals(imported.pin(),snapshot.pin))throw new Failure();active();heldCredential=imported;}
      catch(RuntimeException failure){if(imported!=null)imported.close();throw new Failure();}finally{wipe(key);wipe(cert);}}
    Credential retained=heldCredential;borrows++;
    return new CredentialBorrow(){private boolean ended;
      public byte[] pin(){synchronized(NativeMeshIdentityStore.this){active();if(ended)throw new Failure();nativeCalls++;try{byte[] pin=retained.pin();active();return pin;}finally{nativeCalls--;drainCredential();}}}
      public void withNative(CredentialUse use){synchronized(NativeMeshIdentityStore.this){active();if(ended||use==null)throw new Failure();nativeCalls++;try{use.use(retained);active();}finally{nativeCalls--;drainCredential();}}}
      public void close(){synchronized(NativeMeshIdentityStore.this){if(!ended){ended=true;if(borrows>0)borrows--;}}}
    };
  }
  synchronized View stage(long generation,VerifiedMembershipCommit commit){
    expected(generation);if(commit==null||!commit.take(lease,snapshot.circle))throw new Failure();expected(generation);Record row=new Record(commit.local,commit.remote,false,lease.account,snapshot.pin);
    for(Record old:snapshot.records){if(Arrays.equals(old.id,row.id)){if(!old.same(row))throw new Failure();return new View(snapshot);}if(Arrays.equals(old.pin,row.pin))throw new Failure();}
    Snapshot next=copy();try{next.records.add(row);validateRecords(next);persist(next,false);return new View(snapshot);}finally{if(snapshot!=next)next.wipe();}
  }
  synchronized View promote(long generation,MembershipPromotion promotion){
    expected(generation);if(promotion==null||!promotion.take(lease,snapshot.circle))throw new Failure();expected(generation);Snapshot next=copy();try{Record found=null;
    for(Record row:next.records)if(Arrays.equals(row.id,promotion.id))found=row;
    if(found==null||!Arrays.equals(found.digest,promotion.digest))throw new Failure();if(found.active){next.wipe();return new View(snapshot);}found.active=true;try{revoke.run();}catch(RuntimeException failure){close();throw new Failure();}expected(generation);next.circle=increment(next.circle);persist(next,false);return new View(snapshot);}finally{if(snapshot!=next)next.wipe();}
  }
  synchronized View remove(long generation,String pin){
    expected(generation);if(!hex(pin))throw new Failure();Snapshot next=copy();try{boolean found=next.records.removeIf(row->encode(row.pin).equals(pin));if(!found){next.wipe();throw new Failure();}
    // Revocation precedes persistence; no durable success is reported on uncertain IO.
    try{revoke.run();}catch(RuntimeException failure){close();throw new Failure();}expected(generation);next.circle=increment(next.circle);persist(next,false);return new View(snapshot);}finally{if(snapshot!=next)next.wipe();}
  }
  private Snapshot copy(){Snapshot next=new Snapshot(snapshot.account,increment(snapshot.generation),snapshot.circle,snapshot.key,snapshot.certificate,snapshot.pin);for(Record row:snapshot.records)next.records.add(new Record(row.local,row.remote,row.active,next.account,next.pin));return next;}
  private void checkCredential(Snapshot s){Credential c=port.importDER(s.key,s.certificate);if(c==null)throw new Failure();try{if(!Arrays.equals(c.pin(),s.pin))throw new Failure();}finally{c.close();}}
  private void persist(Snapshot next,boolean initialize){byte[] clear=null,readback=null,prior=null,observed=null;try{active();validateRecords(next);if(snapshot!=null){prior=encode(snapshot);observed=backend.read();if(!Arrays.equals(prior,observed))throw new Failure();}clear=encode(next);backend.write(clear,initialize);active();readback=backend.read();if(!Arrays.equals(clear,readback))throw new Failure();active();if(snapshot!=null)snapshot.wipe();snapshot=next;}
    catch(RuntimeException failure){next.wipe();close();throw new Failure();}finally{wipe(clear);wipe(readback);wipe(prior);wipe(observed);}}
  // Logical revocation is immediate; reentrant close cannot destroy an in-flight native key.
  private void drainCredential(){if(closed&&nativeCalls==0){Credential held=heldCredential;heldCredential=null;if(held!=null)try{held.close();}catch(RuntimeException ignored){/* Authority is already revoked. */}if(registered){synchronized(OPEN_ACCOUNTS){OPEN_ACCOUNTS.remove(lease.account);}registered=false;}}}
  @Override public void close(){lease.revoke();synchronized(this){if(!closed){closed=true;borrows=0;if(snapshot!=null)snapshot.wipe();try{revoke.run();}catch(RuntimeException ignored){/* Already fail closed. */}finally{drainCredential();}}}}
  private static void validateRecords(Snapshot s){Set<String> pins=new HashSet<>(),ids=new HashSet<>(),accounts=new HashSet<>();if(s.records.size()>MAX_DEVICES)throw new Failure();for(Record r:s.records){if(!pins.add(encode(r.pin))||!ids.add(encode(r.id)))throw new Failure();accounts.add(r.account);}if(accounts.size()>MAX_ACCOUNTS)throw new Failure();}
  private static Snapshot decode(byte[] bytes,String account){Snapshot s=null;try{
    if(bytes.length<88||bytes.length>MAX_BYTES)throw new Failure();DataInputStream in=new DataInputStream(new ByteArrayInputStream(bytes));byte[] magic=new byte[5];in.readFully(magic);byte[] user=new byte[32];in.readFully(user);long generation=in.readLong(),circle=in.readLong();int kl=in.readUnsignedShort(),cl=in.readUnsignedShort();byte[] pin=new byte[32];in.readFully(pin);int count=in.readUnsignedByte();
    if(!Arrays.equals(magic,MAGIC)||!encode(user).equals(account)||!revision(generation)||generation==0||!revision(circle)||kl<1||kl>DER_MAX||cl<1||cl>DER_MAX||count>MAX_DEVICES)throw new Failure();byte[] key=new byte[kl],cert=new byte[cl];try{in.readFully(key);in.readFully(cert);s=new Snapshot(account,generation,circle,key,cert,pin);}finally{wipe(key);wipe(cert);}
    for(int i=0;i<count;i++){int state=in.readUnsignedByte();byte[] local=new byte[340],remote=new byte[340];in.readFully(local);in.readFully(remote);if(state>1)throw new Failure();s.records.add(new Record(local,remote,state==1,account,pin));}if(in.read()!=-1)throw new Failure();validateRecords(s);return s;
    }catch(IOException|RuntimeException failure){if(s!=null)s.wipe();throw new Failure();}}
  private static final class SecretOutput extends ByteArrayOutputStream {void wipe(){Arrays.fill(buf,(byte)0);reset();}}
  private static byte[] encode(Snapshot s){SecretOutput bytes=new SecretOutput();try{DataOutputStream out=new DataOutputStream(bytes);out.write(MAGIC);out.write(decodeHex(s.account));out.writeLong(s.generation);out.writeLong(s.circle);out.writeShort(s.key.length);out.writeShort(s.certificate.length);out.write(s.pin);out.writeByte(s.records.size());out.write(s.key);out.write(s.certificate);for(Record row:s.records){out.writeByte(row.active?1:0);out.write(row.local);out.write(row.remote);}byte[] clear=bytes.toByteArray();if(clear.length>MAX_BYTES){wipe(clear);throw new Failure();}return clear;}catch(IOException impossible){throw new Failure();}finally{bytes.wipe();}}
  private static long increment(long value){if(!revision(value)||value==9_007_199_254_740_991L)throw new Failure();return value+1;}
  private static boolean revision(long value){return value>=0&&value<=9_007_199_254_740_991L;}
  private static boolean hex(String value){return value!=null&&value.matches("[0-9a-f]{64}");}
  private static String encode(byte[] value){StringBuilder out=new StringBuilder();for(byte b:value){int n=b&255;out.append("0123456789abcdef".charAt(n>>>4)).append("0123456789abcdef".charAt(n&15));}return out.toString();}
  private static byte[] decodeHex(String value){byte[] out=new byte[value.length()/2];for(int i=0;i<out.length;i++)out[i]=(byte)Integer.parseInt(value.substring(i*2,i*2+2),16);return out;}
  private static byte[] concat(byte[] a,byte[] b){byte[] value=Arrays.copyOf(a,a.length+b.length);System.arraycopy(b,0,value,a.length,b.length);return value;}
  private static byte[] sha(byte[] value){try{return MessageDigest.getInstance("SHA-256").digest(value);}catch(java.security.NoSuchAlgorithmException impossible){throw new Failure();}}
  private static void wipe(byte[] bytes){if(bytes!=null)Arrays.fill(bytes,(byte)0);}
}
