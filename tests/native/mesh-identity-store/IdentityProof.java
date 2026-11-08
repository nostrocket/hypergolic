package org.nostrocket.hypergolic.mesh;

import java.io.File;
import java.io.FileOutputStream;
import java.io.DataOutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.channels.FileChannel;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** Private fixture approval tokens are not actual pairing/signature/device acceptance. */
public final class IdentityProof {
  private static native byte[][] generate();private static native long importCredential(byte[] key,byte[] cert);private static native byte[] pin(long handle);private static native void closeCredential(long handle);
  private static int checks,imports,closed;private static byte[] key,cert,localPin;private static final String USER="11".repeat(32);private static final File ROOT=new File(System.getProperty("proof.output"));
  static void check(boolean b){checks++;if(!b)throw new AssertionError("check "+checks);}
  interface Action{void run()throws Exception;}
  static void denied(Action action){try{action.run();throw new AssertionError("expected denial");}catch(NativeMeshIdentityStore.Failure expected){checks++;}catch(Exception unexpected){throw new AssertionError(unexpected);}}
  static final class Gate{boolean current=true;}
  static final class Memory implements NativeMeshIdentityStore.Backend{byte[] value;int writes;boolean fail;public byte[] read(){return value==null?null:value.clone();}public void write(byte[] bytes,boolean initialize){if(fail)throw new NativeMeshIdentityStore.Failure();check(initialize==(value==null));value=bytes.clone();writes++;}}
  static final class Port implements NativeMeshIdentityStore.CredentialPort{
    byte[] lastKey,lastCert;public NativeMeshIdentityStore.Credential importDER(byte[] k,byte[] c){lastKey=k;lastCert=c;long handle=importCredential(k,c);if(handle==0)throw new NativeMeshIdentityStore.Failure();imports++;return new NativeMeshIdentityStore.Credential(){long pointer=handle;public byte[] pin(){if(pointer==0)throw new NativeMeshIdentityStore.Failure();return IdentityProof.pin(pointer);}public void close(){if(pointer!=0){closeCredential(pointer);pointer=0;closed++;}}};}
  }
  static NativeMeshIdentityStore.AccountLease lease(Gate g){return new NativeMeshIdentityStore.AccountLease(USER,1,1,()->g.current);}
  static NativeMeshIdentityStore make(NativeMeshIdentityStore.AccountLease l,NativeMeshIdentityStore.Backend b,Port p,int[] revoked){return new NativeMeshIdentityStore(l,b,p,()->revoked[0]++);}
  static void initialize(NativeMeshIdentityStore s){s.initialize(sink->sink.capture(key,cert));}
  static byte[] bytes(int value,int count){byte[] b=new byte[count];Arrays.fill(b,(byte)value);return b;}
  static byte[][] binding(int number,int account){byte[] a=new byte[340];byte[] prefix="hypergolic.mesh.pairing.v1\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII);System.arraycopy(prefix,0,a,0,27);a[27]=1;Arrays.fill(a,28,44,(byte)number);Arrays.fill(a,44,76,(byte)5);Arrays.fill(a,76,108,(byte)0x11);Arrays.fill(a,108,140,(byte)account);System.arraycopy(localPin,0,a,140,32);Arrays.fill(a,172,204,(byte)(number+100));Arrays.fill(a,204,236,(byte)6);Arrays.fill(a,236,268,(byte)7);long expiry=1795000000;for(int i=275;i>=268;i--){a[i]=(byte)expiry;expiry>>>=8;}Arrays.fill(a,276,340,(byte)8);byte[] b=a.clone();b[27]=2;Arrays.fill(b,276,340,(byte)9);return new byte[][]{a,b};}
  static NativeMeshIdentityStore.VerifiedMembershipCommit commit(NativeMeshIdentityStore.AccountLease l,byte[][] b){return new NativeMeshIdentityStore.VerifiedMembershipCommit(l,0,b[0],b[1],()->true);}
  static byte[] unhex(String s){return java.util.HexFormat.of().parseHex(s);}
  static NativeMeshIdentityStore.MembershipPromotion promotion(NativeMeshIdentityStore.AccountLease l,NativeMeshIdentityStore.Peer p){return new NativeMeshIdentityStore.MembershipPromotion(l,p.active?1:0,unhex(p.pairingId),unhex(p.bindingsDigest),()->true);}
  static void lifecycle()throws Exception{
    Gate g=new Gate();Memory b=new Memory();Port p=new Port();int[] rev={0};var l=lease(g);var s=make(l,b,p,rev);initialize(s);check(s.view().generation==1&&s.view().peers().isEmpty());check(Arrays.equals(localPin,unhex(s.view().localPin)));check(allZero(p.lastKey)&&allZero(p.lastCert));
    denied(()->make(lease(new Gate()),new Memory(),new Port(),new int[1]));var c=s.withCredential();check(Arrays.equals(c.pin(),localPin));check(allZero(p.lastKey)&&allZero(p.lastCert));int importsBefore=imports;var borrow2=s.withCredential();var borrow3=s.withCredential();var borrow4=s.withCredential();denied(s::withCredential);check(imports==importsBefore);final int[] uses={0};c.withNative(nativeCredential->{check(Arrays.equals(nativeCredential.pin(),localPin));uses[0]++;});check(uses[0]==1);borrow2.close();borrow3.close();borrow4.close();
    byte[][] pair=binding(1,0x22);var token=commit(l,pair);var pending=s.stage(1,token);check(pending.generation==2&&pending.circleRevision==0&&pending.activeAccounts()==0&&!pending.peers().get(0).active);denied(()->s.stage(2,token));pair[0][172]^=1;
    var duplicate=s.stage(2,commit(l,binding(1,0x22)));check(duplicate.generation==2&&b.writes==2);var staleCircle=commit(l,binding(2,0x22));var promotion=promotion(l,pending.peers().get(0));var active=s.promote(2,promotion);check(active.generation==3&&active.circleRevision==1&&active.activeAccounts()==1);denied(()->s.promote(3,promotion));denied(()->s.stage(3,staleCircle));check(s.promote(3,promotion(l,active.peers().get(0))).generation==3);
    byte[] expected=b.value.clone();try(DataOutputStream out=new DataOutputStream(new FileOutputStream(new File(ROOT,"credential.fixture")))){out.writeInt(key.length);out.write(key);out.writeInt(cert.length);out.write(cert);out.write(localPin);}Files.write(new File(ROOT,"java-snapshot.bin").toPath(),expected);
    var foreign=commit(lease(new Gate()),binding(2,0x33));denied(()->s.stage(3,foreign));denied(()->s.stage(99,commit(l,binding(2,0x33))));byte[][] bad=binding(2,0x33);bad[1][76]^=1;denied(()->s.stage(3,new NativeMeshIdentityStore.VerifiedMembershipCommit(l,1,bad[0],bad[1],()->true)));var badFinal=binding(1,0x33);denied(()->s.stage(3,new NativeMeshIdentityStore.VerifiedMembershipCommit(l,1,badFinal[0],badFinal[1],()->true)));
    var removed=s.remove(3,active.peers().get(0).pin);check(removed.peers().isEmpty()&&removed.circleRevision==2&&rev[0]==2);g.current=false;denied(s::view);denied(c::pin);check(rev[0]==3);s.close();c.close();
    g.current=true;try(var reopened=make(lease(g),b,p,new int[1])){check(reopened.view().generation==4&&reopened.view().peers().isEmpty());}
  }
  static boolean allZero(byte[] b){for(byte x:b)if(x!=0)return false;return true;}
  static void limits(){
    Memory b=new Memory();Port p=new Port();var l=lease(new Gate());var firstLease=l;try(var s=make(l,b,p,new int[1])){initialize(s);for(int i=1;i<=32;i++){int account=i<=15?i:(i==16?0x11:1);check(s.stage(s.view().generation,commit(l,binding(i,account))).peers().size()==i);}denied(()->s.stage(s.view().generation,commit(firstLease,binding(33,1))));}
    b=new Memory();l=lease(new Gate());try(var s=make(l,b,p,new int[1])){initialize(s);for(int i=1;i<=16;i++)s.stage(s.view().generation,commit(l,binding(i,i)));var finalLease=l;denied(()->s.stage(s.view().generation,commit(finalLease,binding(17,18))));}
  }
  static void parser()throws Exception{
    byte[] valid=Files.readAllBytes(new File(ROOT,"java-snapshot.bin").toPath());int[] positions={0,4,5,37,45,53,54,55,56,89};for(int pos:positions){Memory b=new Memory();b.value=valid.clone();b.value[pos]^=(byte)0x80;denied(()->make(lease(new Gate()),b,new Port(),new int[1]));}
    for(int len:new int[]{0,4,36,87,valid.length-1,valid.length+1,131073}){Memory b=new Memory();b.value=Arrays.copyOf(valid,len);denied(()->make(lease(new Gate()),b,new Port(),new int[1]));}
    Memory altered=new Memory();altered.value=valid.clone();var own=lease(new Gate());try(var s=make(own,altered,new Port(),new int[1])){altered.value[45]^=1;denied(()->s.stage(s.view().generation,new NativeMeshIdentityStore.VerifiedMembershipCommit(own,1,binding(2,1)[0],binding(2,1)[1],()->true)));}
    Memory corrupt=new Memory();corrupt.value=valid.clone();corrupt.value[90]^=1;denied(()->make(lease(new Gate()),corrupt,new Port(),new int[1]));
    Memory uncertain=new Memory();var l=lease(new Gate());var s=make(l,uncertain,new Port(),new int[1]);initialize(s);uncertain.fail=true;denied(()->s.stage(1,commit(l,binding(1,1))));denied(s::view);s.close();
  }
  static void ownership(){
    Memory b=new Memory();Gate gate=new Gate();var old=lease(gate);var first=make(old,b,new Port(),new int[1]);initialize(first);byte[][] input=binding(7,0x22);var captured=commit(old,input);input[0][172]^=1;var pending=first.stage(1,captured);check(pending.activeAccounts()==0);first.close();
    var fresh=lease(gate);try(var reopened=make(fresh,b,new Port(),new int[1])){check(reopened.view().activeAccounts()==0&&!reopened.view().peers().get(0).active);denied(()->reopened.stage(2,commit(old,binding(8,0x22))));
      var peer=reopened.view().peers().get(0);var rejected=new NativeMeshIdentityStore.MembershipPromotion(fresh,0,unhex(peer.pairingId),unhex(peer.bindingsDigest),()->false);denied(()->reopened.promote(2,rejected));denied(()->reopened.promote(2,rejected));check(reopened.view().activeAccounts()==0);check(reopened.promote(2,promotion(fresh,peer)).activeAccounts()==1);
      byte[][] conflict=binding(7,0x22);conflict[0][276]^=1;denied(()->reopened.stage(3,new NativeMeshIdentityStore.VerifiedMembershipCommit(fresh,1,conflict[0],conflict[1],()->true)));
    }
    Memory changed=new Memory();Gate lost=new Gate();var l=lease(lost);var stale=make(l,changed,new Port(),new int[1]);initialize(stale);var token=new NativeMeshIdentityStore.VerifiedMembershipCommit(l,0,binding(1,1)[0],binding(1,1)[1],()->{lost.current=false;return true;});denied(()->stale.stage(1,token));denied(stale::view);stale.close();
    Memory joinMemory=new Memory();var joinLease=lease(new Gate());try(var joiner=make(joinLease,joinMemory,new Port(),new int[1])){initialize(joiner);byte[][] join=binding(9,0x22);for(byte[] transcript:join){byte[] a=Arrays.copyOfRange(transcript,76,108),pin=Arrays.copyOfRange(transcript,140,172);System.arraycopy(transcript,108,transcript,76,32);System.arraycopy(a,0,transcript,108,32);System.arraycopy(transcript,172,transcript,140,32);System.arraycopy(pin,0,transcript,172,32);}join[0][27]=2;join[1][27]=1;check(joiner.stage(1,commit(joinLease,join)).peers().get(0).account.equals("22".repeat(32)));}
  }
  static void reentrantLifetime(){
    NativeMeshIdentityStore.AccountLease[] self=new NativeMeshIdentityStore.AccountLease[1];
    self[0]=new NativeMeshIdentityStore.AccountLease(USER,1,1,()->{self[0].revoke();return true;});check(!self[0].isCurrent());
    NativeMeshIdentityStore[] holder=new NativeMeshIdentityStore[1];boolean[] trigger={false};
    var l=new NativeMeshIdentityStore.AccountLease(USER,1,1,()->{if(trigger[0]){trigger[0]=false;holder[0].close();}return true;});
    holder[0]=make(l,new Memory(),new Port(),new int[1]);initialize(holder[0]);var borrow=holder[0].withCredential();int before=closed;boolean[] invoked={false};trigger[0]=true;
    denied(()->borrow.withNative(nativeCredential->invoked[0]=true));check(!invoked[0]&&!l.isCurrent()&&closed==before+1);borrow.close();holder[0].close();check(closed==before+1);
    Memory b=new Memory();var lease=lease(new Gate());var s=make(lease,b,new Port(),new int[1]);initialize(s);var outer=s.withCredential();var inner=s.withCredential();int masterClosed=closed;
    denied(()->outer.withNative(nativeCredential->{
      denied(()->inner.withNative(nested->{s.close();check(!lease.isCurrent()&&closed==masterClosed);check(Arrays.equals(nested.pin(),localPin));denied(()->make(lease(new Gate()),b,new Port(),new int[1]));throw new NativeMeshIdentityStore.Failure();}));
      check(closed==masterClosed);check(Arrays.equals(nativeCredential.pin(),localPin));denied(inner::pin);
    }));
    check(closed==masterClosed+1);s.close();outer.close();inner.close();check(closed==masterClosed+1);
    try(var reopened=make(lease(new Gate()),b,new Port(),new int[1])){check(reopened.view().generation==1);}
  }
  static void concurrentLifetime()throws Exception{
    var l=lease(new Gate());var s=make(l,new Memory(),new Port(),new int[1]);initialize(s);var borrow=s.withCredential();int before=closed;
    var returned=new java.util.concurrent.atomic.AtomicBoolean();Thread closer=new Thread(()->{s.close();returned.set(true);},"mesh-identity-close");
    denied(()->borrow.withNative(nativeCredential->{
      closer.start();long deadline=System.nanoTime()+2_000_000_000L;while(l.isCurrent()&&System.nanoTime()<deadline)java.util.concurrent.locks.LockSupport.parkNanos(1_000_000L);
      check(!l.isCurrent());check(!returned.get()&&closed==before);check(Arrays.equals(nativeCredential.pin(),localPin));
    }));
    closer.join(2000);check(!closer.isAlive()&&returned.get()&&closed==before+1);borrow.close();s.close();check(closed==before+1);
  }
  static final class TestKeys implements NativeMeshIdentityFile.Keys{SecretKey key;public boolean exists(){return key!=null;}public SecretKey key(boolean create)throws Exception{if(key==null){if(!create)throw new Exception();KeyGenerator g=KeyGenerator.getInstance("AES");g.init(256);key=g.generateKey();}return key;}}
  static final class Durability implements NativeMeshIdentityFile.Durability{int fault,stage;public void syncFile(FileOutputStream s)throws Exception{stage++;if(fault==stage)throw new Exception();s.getFD().sync();}public void replace(File a,File b)throws Exception{stage++;if(fault==stage)throw new Exception();Files.move(a.toPath(),b.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}public void syncDirectory(File directory)throws Exception{stage++;if(fault==stage)throw new Exception();try(FileChannel c=FileChannel.open(directory.toPath(),StandardOpenOption.READ)){c.force(true);}}}
  static NativeMeshIdentityFile.FileStore file(File d,TestKeys k,Durability durability,String account){return new NativeMeshIdentityFile.FileStore(new NativeMeshIdentityFile.Address(d,"ab".repeat(32),account),k,durability,()->true);}
  static void files()throws Exception{
    byte[] valid=Files.readAllBytes(new File(ROOT,"java-snapshot.bin").toPath());File d=new File(ROOT,"files");check(d.mkdir());TestKeys keys=new TestKeys();var store=file(d,keys,new Durability(),USER);check(store.read()==null);store.write(valid,true);check(Arrays.equals(store.read(),valid));byte[] disk=Files.readAllBytes(new File(d,"ab".repeat(32)+".bin").toPath());check(!new String(disk,java.nio.charset.StandardCharsets.ISO_8859_1).contains("hypergolic.mesh.pairing"));
    denied(()->file(d,keys,new Durability(),"22".repeat(32)).read());byte[] tampered=disk.clone();tampered[tampered.length-1]^=1;Files.write(new File(d,"ab".repeat(32)+".bin").toPath(),tampered);denied(()->file(d,keys,new Durability(),USER).read());Files.write(new File(d,"ab".repeat(32)+".bin").toPath(),disk);denied(()->file(d,new TestKeys(),new Durability(),USER).read());
    File missing=new File(ROOT,"missing-file");check(missing.mkdir());denied(()->file(missing,keys,new Durability(),USER).read());
    for(int point=1;point<=4;point++){File dir=new File(ROOT,"fault-"+point);check(dir.mkdir());TestKeys k=new TestKeys();var first=file(dir,k,new Durability(),USER);first.write(valid,true);Durability fault=new Durability();fault.fault=point;var f=file(dir,k,fault,USER);byte[] changed=valid.clone();changed[44]++;denied(()->f.write(changed,false));denied(f::read);byte[] after=file(dir,k,new Durability(),USER).read();check(Arrays.equals(after,point<=2?valid:changed));}
    File residue=new File(ROOT,"residue");check(residue.mkdir());Files.write(new File(residue,"ab".repeat(32)+".new").toPath(),new byte[]{1});denied(()->file(residue,new TestKeys(),new Durability(),USER).read());
  }
  public static void main(String[] args)throws Exception{
    System.load(args[0]);byte[][] generated=generate();check(generated!=null&&generated.length==3);key=generated[0];cert=generated[1];localPin=generated[2];check(key.length>0&&cert.length>0&&localPin.length==32);
    lifecycle();limits();parser();ownership();reentrantLifetime();concurrentLifetime();files();check(imports==closed);System.out.println("{\"status\":\"passed\",\"checks\":"+checks+",\"actualTLSImports\":"+imports+",\"allCredentialsClosed\":true,\"snapshotSHA256\":\""+java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(new File(ROOT,"java-snapshot.bin").toPath())))+"\",\"scope\":\"host AES-GCM real files and actual C TLS import; no AndroidKeyStore/device or pairing-signature acceptance\"}");Arrays.fill(key,(byte)0);Arrays.fill(cert,(byte)0);
  }
}
