package org.nostrocket.hypergolic.host;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public final class StoreProof {
  static int checks;
  static final String ACCOUNT="1".repeat(64),OTHER="2".repeat(64),SIG="0".repeat(128);
  static final NativeMeshStore.Verifier FIXTURE_VERIFIER=(author,digest,signature)->SIG.equals(signature);
  static final NativeMeshStore.Durability DISK=new NativeMeshStore.Durability(){
    public void syncFile(FileOutputStream stream)throws Exception{stream.getFD().sync();}
    public void syncDirectory(File directory)throws Exception{try(FileChannel channel=FileChannel.open(directory.toPath(),StandardOpenOption.READ)){channel.force(true);}}
    public void replace(File staged,File target)throws Exception{Files.move(staged.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
  };
  static class State {volatile long revision=1,now,wall=1794100100;volatile boolean active=true;volatile int tick;}
  static class Owner implements NativeMeshStore.Owner {
    final State state;final long revision,deadline;final String account;
    Owner(State state,String account,long deadline){this.state=state;this.account=account;revision=state.revision;this.deadline=deadline;}
    public String account(){return account;}public long originalDeadlineMillis(){return deadline;}public long monotonicMillis(){long value=state.now;state.now+=state.tick;return value;}public long wallSeconds(){return state.wall;}public boolean current(){return state.active&&state.revision==revision;}
    public void withCurrentMutation(NativeMeshStore.Mutation body)throws Exception{synchronized(state){if(!current())throw new NativeMeshStore.Failure(NativeMeshStore.Code.DENIED,false);body.run();if(!current())throw new NativeMeshStore.Failure(NativeMeshStore.Code.DENIED,true);}}
  }
  static class Fixture {
    final File root;final State state=new State();final Owner owner=new Owner(state,ACCOUNT,15000);NativeMeshStore store;
    Fixture(Path out,String name)throws Exception{root=Files.createDirectory(out.resolve(name)).toFile();store=open(owner,true,new NativeMeshStore.Limits(),stage->{});}
    NativeMeshStore open(Owner owner,boolean initialize,NativeMeshStore.Limits limits,NativeMeshStore.Fault fault){return NativeMeshStore.open(root,owner,FIXTURE_VERIFIER,initialize,limits,new NativeMeshStore.IoPorts(DISK,fault));}
    NativeMeshStore.Event event(String label,int kind,long created,List<List<String>> tags){return StoreProof.event(store,owner,label,kind,created,ACCOUNT,tags);}
  }
  static void check(boolean value){checks++;if(!value)throw new AssertionError("check "+checks);}
  @FunctionalInterface interface Action{void run()throws Exception;}
  static NativeMeshStore.Failure failure(NativeMeshStore.Code code,Action body)throws Exception{try{body.run();throw new AssertionError("Expected "+code);}catch(NativeMeshStore.Failure e){check(e.code==code);return e;}}
  static String hash(byte[] value)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));}
  static NativeMeshStore.Event event(NativeMeshStore store,Owner owner,String content,int kind,long created,String author,List<List<String>> tags){
    String encodedTags="["+String.join(",",tags.stream().map(row->"["+String.join(",",row.stream().map(NativeCanonicalJSON.INSTANCE::quote).toList())+"]").toList())+"]";
    String canonical="[0,\""+author+"\","+created+","+kind+","+encodedTags+","+NativeCanonicalJSON.INSTANCE.quote(content)+"]";
    try{return store.captureVerified(owner,new NativeMeshStore.EventHeader(hash(canonical.getBytes(StandardCharsets.UTF_8)),author,created,kind,SIG),new NativeMeshStore.EventBody(content,tags));}catch(Exception e){throw new IllegalStateException(e);}
  }
  static NativeMeshStore.Filter all(){return new NativeMeshStore.Filter(null,null,null,null,new NativeMeshStore.FilterWindow(null,null,null));}
  static void restartAndEphemeral(Path out)throws Exception{
    Fixture f=new Fixture(out,"restart");var permanent=f.event("kept quote\"/雪",1,1794100000,List.of(List.of("t","kept")));
    check(f.store.keep(f.owner,permanent)==NativeMeshStore.Kept.DURABLE);check(f.store.keep(f.owner,permanent)==NativeMeshStore.Kept.DUPLICATE);check(f.store.claimForward(f.owner,permanent));check(!f.store.claimForward(f.owner,permanent));String wire=permanent.wire;f.store.close();
    f.store=f.open(f.owner,false,new NativeMeshStore.Limits(),stage->{});var rows=f.store.backlog(f.owner,List.of(all()));check(rows.size()==1&&rows.get(0).wire.equals(wire));check(!f.store.claimForward(f.owner,rows.get(0)));
    var ephemeral=f.event("EPHEMERAL-UNIQUE-CONTENT-NEVER-DISK",20431,1794100001,List.of(List.of("t","EPHEMERAL-TAG-NEVER-DISK"),List.of("expiration",Long.toString(f.state.wall+60))));
    check(f.store.keep(f.owner,ephemeral)==NativeMeshStore.Kept.EPHEMERAL);check(f.store.claimForward(f.owner,ephemeral));check(f.store.backlog(f.owner,List.of(all())).size()==1);
    try(var paths=Files.walk(f.root.toPath())){for(Path p:paths.filter(Files::isRegularFile).toList()){String bytes=new String(Files.readAllBytes(p),StandardCharsets.ISO_8859_1);check(!bytes.contains("EPHEMERAL-UNIQUE")&&!bytes.contains("EPHEMERAL-TAG"));}}
    f.store.close();f.store=f.open(f.owner,false,new NativeMeshStore.Limits(),stage->{});var same=f.event("EPHEMERAL-UNIQUE-CONTENT-NEVER-DISK",20431,1794100001,List.of(List.of("t","EPHEMERAL-TAG-NEVER-DISK"),List.of("expiration",Long.toString(f.state.wall+60))));check(!f.store.claimForward(f.owner,same));check(f.store.backlog(f.owner,List.of(all())).size()==1);
    Owner other=new Owner(new State(),OTHER,15000);var isolated=f.open(other,true,new NativeMeshStore.Limits(),stage->{});check(isolated.backlog(other,List.of(all())).isEmpty());failure(NativeMeshStore.Code.DENIED,()->isolated.backlog(f.owner,List.of(all())));failure(NativeMeshStore.Code.INVALID,()->isolated.keep(other,permanent));isolated.close();f.store.close();
  }
  static void filtersAndCursors(Path out)throws Exception{
    Fixture f=new Fixture(out,"filters");List<NativeMeshStore.Event> events=new ArrayList<>();
    for(int i=0;i<6;i++){var e=event(f.store,f.owner,"row"+i,i<4?1:2,1794100000+i,i%2==0?ACCOUNT:OTHER,List.of(List.of("t",i==1?"é":"é"),List.of("a","x")));f.store.keep(f.owner,e);events.add(e);}
    var exact=new NativeMeshStore.Filter(null,List.of(OTHER),List.of(1),Map.of("#t",List.of("é"),"#a",List.of("x")),new NativeMeshStore.FilterWindow(1794100001L,1794100001L,32L));
    check(f.store.backlog(f.owner,List.of(exact)).stream().map(e->e.id).toList().equals(List.of(events.get(1).id)));
    var mismatch=new NativeMeshStore.Filter(null,List.of(OTHER),List.of(1),Map.of("#t",List.of("é")),new NativeMeshStore.FilterWindow(1794100001L,1794100001L,null));check(f.store.backlog(f.owner,List.of(mismatch)).isEmpty());
    var one=new NativeMeshStore.Filter(null,null,List.of(1),null,new NativeMeshStore.FilterWindow(null,null,1L));var two=new NativeMeshStore.Filter(null,null,List.of(2),null,new NativeMeshStore.FilterWindow(null,null,1L));var union=f.store.backlog(f.owner,List.of(one,two));check(union.size()==2&&union.get(0).id.equals(events.get(5).id)&&union.get(1).id.equals(events.get(3).id));
    var zero=new NativeMeshStore.Filter(null,null,null,null,new NativeMeshStore.FilterWindow(null,null,0L));check(f.store.backlog(f.owner,List.of(zero)).isEmpty());var live=new NativeMeshStore.DeliveryCursor(List.of(zero),2);check(live.accept(events.get(0),false,f.state.wall));check(!live.accept(events.get(0),false,f.state.wall));
    check(f.store.claimForward(f.owner,events.get(0)));var local=new NativeMeshStore.DeliveryCursor(List.of(all()),2);var remote=new NativeMeshStore.DeliveryCursor(List.of(all()),1);check(local.accept(events.get(0),true,f.state.wall));check(remote.accept(events.get(0),true,f.state.wall));check(!remote.accept(events.get(0),false,f.state.wall));failure(NativeMeshStore.Code.FULL,()->remote.accept(events.get(1),false,f.state.wall));
    var expired=f.event("expiry",1,1794100006,List.of(List.of("expiration",Long.toString(f.state.wall+1))));f.store.keep(f.owner,expired);f.state.wall++;check(f.store.backlog(f.owner,List.of(all())).size()==6);check(!local.accept(expired,false,f.state.wall));
    f.state.tick=1;Owner deadline=new Owner(f.state,ACCOUNT,f.state.now+8);failure(NativeMeshStore.Code.DENIED,()->f.store.backlog(deadline,List.of(all())));f.state.tick=0;f.state.revision++;failure(NativeMeshStore.Code.DENIED,()->f.store.backlog(f.owner,List.of(all())));f.store.close();
  }
  static void quotasAndFailures(Path out)throws Exception{
    Fixture f=new Fixture(out,"quotas");f.store.close();var limits=new NativeMeshStore.Limits(8192,2,8,128);f.store=f.open(f.owner,false,limits,stage->{});
    var a=f.event("a",1,1,List.of());var b=f.event("b",1,2,List.of());var c=f.event("c",1,3,List.of());f.store.keep(f.owner,a);f.store.keep(f.owner,b);failure(NativeMeshStore.Code.FULL,()->f.store.keep(f.owner,c));check(f.store.claimForward(f.owner,a));check(f.store.claimForward(f.owner,b));failure(NativeMeshStore.Code.FULL,()->f.store.claimForward(f.owner,c));check(!f.store.claimForward(f.owner,a));f.store.close();
    Fixture before=new Fixture(out,"before");before.store.close();boolean[] armed={true};before.store=before.open(before.owner,false,new NativeMeshStore.Limits(),stage->{if(armed[0]&&stage==NativeMeshStore.Stage.STAGED)throw new IOException("controlled");});var event=before.event("not-committed",1,1,List.of());check(!failure(NativeMeshStore.Code.UNAVAILABLE,()->before.store.keep(before.owner,event)).mutationUnknown);check(Objects.requireNonNull(new File(before.root,ACCOUNT+"/events").list()).length==0);before.store.close();before.store=before.open(before.owner,false,new NativeMeshStore.Limits(),stage->{});check(before.store.backlog(before.owner,List.of(all())).isEmpty());before.store.close();
    Fixture after=new Fixture(out,"after");after.store.close();after.store=after.open(after.owner,false,new NativeMeshStore.Limits(),stage->{if(stage==NativeMeshStore.Stage.RENAMED)throw new IOException("controlled");});var uncertain=after.event("may-be-committed",1,1,List.of());check(failure(NativeMeshStore.Code.UNAVAILABLE,()->after.store.keep(after.owner,uncertain)).mutationUnknown);after.store.close();after.store=after.open(after.owner,false,new NativeMeshStore.Limits(),stage->{});check(after.store.backlog(after.owner,List.of(all())).size()==1);after.store.close();
    Fixture partial=new Fixture(out,"partial");partial.store.close();partial.store=partial.open(partial.owner,false,new NativeMeshStore.Limits(),stage->{if(stage==NativeMeshStore.Stage.LEDGER_APPENDED){try(RandomAccessFile file=new RandomAccessFile(new File(partial.root,ACCOUNT+"/forward.bin"),"rw")){file.setLength(file.length()-1);}throw new IOException("controlled");}});var p=partial.event("partial",1,1,List.of());check(failure(NativeMeshStore.Code.UNAVAILABLE,()->partial.store.claimForward(partial.owner,p)).mutationUnknown);long size=new File(partial.root,ACCOUNT+"/forward.bin").length();partial.store.close();failure(NativeMeshStore.Code.UNAVAILABLE,()->partial.open(partial.owner,false,new NativeMeshStore.Limits(),stage->{}));check(new File(partial.root,ACCOUNT+"/forward.bin").length()==size);
  }
  static void typedMutationFailures(Path out)throws Exception{
    for(var code:List.of(NativeMeshStore.Code.UNAVAILABLE,NativeMeshStore.Code.DENIED)){
      for(var stage:List.of(NativeMeshStore.Stage.STAGED,NativeMeshStore.Stage.FILE_SYNCED,NativeMeshStore.Stage.RENAMED,NativeMeshStore.Stage.DIRECTORY_SYNCED)){
        Fixture f=new Fixture(out,"typed-"+code+"-"+stage);f.store.close();f.store=f.open(f.owner,false,new NativeMeshStore.Limits(),at->{if(at==stage)throw new NativeMeshStore.Failure(code,false);});var e=f.event("typed fault",1,1,List.of());boolean changed=stage==NativeMeshStore.Stage.RENAMED||stage==NativeMeshStore.Stage.DIRECTORY_SYNCED;
        check(failure(code,()->f.store.keep(f.owner,e)).mutationUnknown==changed);f.store.close();f.store=f.open(f.owner,false,new NativeMeshStore.Limits(),at->{});check(f.store.backlog(f.owner,List.of(all())).size()==(changed?1:0));f.store.close();
      }
      Fixture ledger=new Fixture(out,"typed-ledger-"+code);ledger.store.close();ledger.store=ledger.open(ledger.owner,false,new NativeMeshStore.Limits(),at->{if(at==NativeMeshStore.Stage.LEDGER_APPENDED)throw new NativeMeshStore.Failure(code,false);});var e=ledger.event("typed ledger",1,1,List.of());check(failure(code,()->ledger.store.claimForward(ledger.owner,e)).mutationUnknown);ledger.store.close();
      Path fresh=Files.createDirectory(out.resolve("typed-open-"+code));State state=new State();Owner owner=new Owner(state,ACCOUNT,15000);check(failure(code,()->NativeMeshStore.open(fresh.toFile(),owner,FIXTURE_VERIFIER,true,new NativeMeshStore.Limits(),new NativeMeshStore.IoPorts(DISK,at->{if(at==NativeMeshStore.Stage.RENAMED)throw new NativeMeshStore.Failure(code,false);}))).mutationUnknown);
    }
    Fixture prior=new Fixture(out,"typed-already-unknown");prior.store.close();prior.store=prior.open(prior.owner,false,new NativeMeshStore.Limits(),at->{if(at==NativeMeshStore.Stage.STAGED)throw new NativeMeshStore.Failure(NativeMeshStore.Code.DENIED,true);});var e=prior.event("already unknown",1,1,List.of());check(failure(NativeMeshStore.Code.DENIED,()->prior.store.keep(prior.owner,e)).mutationUnknown);prior.store.close();
  }
  static void blobs(Path out)throws Exception{
    Fixture f=new Fixture(out,"blobs");byte[] bytes="EXPLICIT SHARED BLOB".getBytes(StandardCharsets.UTF_8);String id=hash(bytes),missing="f".repeat(64);
    check(f.store.presence(f.owner,List.of(id,missing)).equals(Map.of(id,0,missing,0)));failure(NativeMeshStore.Code.INVALID,()->f.store.shareBlob(f.owner,missing,bytes));f.store.shareBlob(f.owner,id,bytes);check(f.store.presence(f.owner,List.of(id)).get(id)==1);f.store.close();f.store=f.open(f.owner,false,new NativeMeshStore.Limits(),stage->{});check(f.store.presence(f.owner,List.of(id)).get(id)==1);f.store.unshareBlob(f.owner,id);check(f.store.presence(f.owner,List.of(id)).get(id)==0);
    String empty=hash(new byte[0]);f.store.shareBlob(f.owner,empty,new byte[0]);check(f.store.presence(f.owner,List.of(empty)).get(empty)==1);f.store.shareBlob(f.owner,id,bytes);check(new File(f.root,ACCOUNT+"/blobs/"+id+".blob").delete());failure(NativeMeshStore.Code.UNAVAILABLE,()->f.store.presence(f.owner,List.of(id)));failure(NativeMeshStore.Code.UNAVAILABLE,()->f.store.presence(f.owner,List.of(missing)));f.store.close();
    Fixture corrupt=new Fixture(out,"corrupt-blob");corrupt.store.shareBlob(corrupt.owner,id,bytes);Files.write(new File(corrupt.root,ACCOUNT+"/blobs/"+id+".blob").toPath(),new byte[]{1});failure(NativeMeshStore.Code.UNAVAILABLE,()->corrupt.store.presence(corrupt.owner,List.of(id)));corrupt.store.close();
  }
  static void revocationAndConcurrency(Path out)throws Exception{
    Fixture f=new Fixture(out,"revoke");f.store.close();f.store=f.open(f.owner,false,new NativeMeshStore.Limits(),stage->{if(stage==NativeMeshStore.Stage.STAGED)f.state.revision++;});var e=f.event("revoked-before-rename",1,1,List.of());failure(NativeMeshStore.Code.DENIED,()->f.store.keep(f.owner,e));check(Objects.requireNonNull(new File(f.root,ACCOUNT+"/events").list()).length==0);f.store.close();Owner fresh=new Owner(f.state,ACCOUNT,15000);var reopened=f.open(fresh,false,new NativeMeshStore.Limits(),stage->{});check(reopened.backlog(fresh,List.of(all())).isEmpty());reopened.close();
    Fixture parallel=new Fixture(out,"parallel");var second=parallel.open(parallel.owner,false,new NativeMeshStore.Limits(),stage->{});var firstEvent=parallel.event("same",1,1,List.of());var secondEvent=event(second,parallel.owner,"same",1,1,ACCOUNT,List.of());CountDownLatch ready=new CountDownLatch(2),go=new CountDownLatch(1);AtomicInteger claims=new AtomicInteger(),errors=new AtomicInteger();Thread a=new Thread(()->{ready.countDown();try{go.await();if(parallel.store.claimForward(parallel.owner,firstEvent))claims.incrementAndGet();}catch(Exception failure){errors.incrementAndGet();}}),b=new Thread(()->{ready.countDown();try{go.await();if(second.claimForward(parallel.owner,secondEvent))claims.incrementAndGet();}catch(Exception failure){errors.incrementAndGet();}});a.start();b.start();check(ready.await(2,TimeUnit.SECONDS));go.countDown();a.join(5000);b.join(5000);if(a.isAlive()||b.isAlive()){parallel.state.active=false;throw new AssertionError("workers did not drain");}check(errors.get()==0&&claims.get()==1);second.close();parallel.store.close();
  }
  static void reentrantCurrent(Path out)throws Exception{
    Fixture capture=new Fixture(out,"current-close-capture");var e=capture.event("capture",1,1,List.of());var header=new NativeMeshStore.EventHeader(e.id,e.author,e.createdAt,e.kind,e.signature);var body=new NativeMeshStore.EventBody(e.content,e.tags);AtomicInteger calls=new AtomicInteger();Owner counting=new Owner(capture.state,ACCOUNT,15000){public boolean current(){calls.incrementAndGet();return super.current();}};
    capture.store.captureVerified(counting,header,body);int captureChecks=calls.get();check(captureChecks>0);calls.set(0);Owner closing=new Owner(capture.state,ACCOUNT,15000){public boolean current(){if(calls.incrementAndGet()==captureChecks)capture.store.close();return true;}};check(!failure(NativeMeshStore.Code.DENIED,()->capture.store.captureVerified(closing,header,body)).mutationUnknown);failure(NativeMeshStore.Code.DENIED,()->capture.store.backlog(capture.owner,List.of(all())));
    Fixture baseline=new Fixture(out,"current-close-baseline");var base=baseline.event("keep",1,1,List.of());calls.set(0);Owner countKeep=new Owner(baseline.state,ACCOUNT,15000){public boolean current(){calls.incrementAndGet();return super.current();}};check(baseline.store.keep(countKeep,base)==NativeMeshStore.Kept.DURABLE);int keepChecks=calls.get();baseline.store.close();
    Fixture mutation=new Fixture(out,"current-close-mutation");var kept=mutation.event("keep",1,1,List.of());calls.set(0);Owner closeKeep=new Owner(mutation.state,ACCOUNT,15000){public boolean current(){if(calls.incrementAndGet()==keepChecks)mutation.store.close();return true;}};check(failure(NativeMeshStore.Code.DENIED,()->mutation.store.keep(closeKeep,kept)).mutationUnknown);mutation.store=mutation.open(mutation.owner,false,new NativeMeshStore.Limits(),stage->{});check(mutation.store.backlog(mutation.owner,List.of(all())).size()==1);mutation.store.close();
  }
  static void sameHandleDeadline(Path out)throws Exception{
    Fixture f=new Fixture(out,"lock-deadline");f.store.close();CountDownLatch staged=new CountDownLatch(1),release=new CountDownLatch(1);AtomicInteger errors=new AtomicInteger();
    f.store=f.open(f.owner,false,new NativeMeshStore.Limits(),stage->{if(stage==NativeMeshStore.Stage.STAGED){staged.countDown();if(!release.await(3,TimeUnit.SECONDS))throw new IOException("release timed out");}});
    var event=f.event("held",1,1,List.of());Thread writer=new Thread(()->{try{f.store.keep(f.owner,event);}catch(Exception failure){errors.incrementAndGet();}});writer.start();
    try{check(staged.await(2,TimeUnit.SECONDS));Owner shortOwner=new Owner(f.state,ACCOUNT,3){long ticks;public long monotonicMillis(){return ticks++;}};failure(NativeMeshStore.Code.DENIED,()->f.store.backlog(shortOwner,List.of(all())));check(writer.isAlive());}finally{release.countDown();writer.join(4000);f.store.close();}check(!writer.isAlive()&&errors.get()==0);
  }
  public static void main(String[] args)throws Exception{Path out=Path.of(args[0]);Files.createDirectory(out);check(new NativeMeshStore.Limits().ledger/64==1_048_576);restartAndEphemeral(out);filtersAndCursors(out);quotasAndFailures(out);typedMutationFailures(out);blobs(out);revocationAndConcurrency(out);sameHandleDeadline(out);reentrantCurrent(out);System.out.println("{\"status\":\"passed\",\"checks\":"+checks+",\"scope\":\"actual durable files/restart/faults; fixture verifier only, no real signer/device acceptance\"}");}
}
