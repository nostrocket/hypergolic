package org.nostrocket.hypergolic.host;

import android.system.Os;
import android.system.OsConstants;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.locks.ReentrantLock;

/** Native-only durable Mesh data. Synchronous IO: the coordinator must dispatch off UI threads. */
public final class NativeMeshStore implements AutoCloseable {
  public static final long EVENT_BYTES=64L*1024*1024, BLOB_BYTES=64L*1024*1024, LEDGER_BYTES=64L*1024*1024;
  public static final int EVENT_COUNT=20_000, FRAME_BYTES=8192, RECORD_BYTES=16_384;
  public enum Code { INVALID, DENIED, FULL, UNAVAILABLE }
  public static final class Failure extends RuntimeException {
    private static final long serialVersionUID=1L;
    public final Code code;public final boolean mutationUnknown;
    Failure(Code code,boolean unknown){super("Mesh store "+code.name().toLowerCase(Locale.ROOT));this.code=code;mutationUnknown=unknown;}
  }
  @FunctionalInterface public interface Mutation {void run() throws Exception;}
  /** Native authority adapter; originalDeadlineMillis is immutable, and withCurrentMutation fences revocation. */
  public interface Owner {
    String account();long originalDeadlineMillis();long monotonicMillis();long wallSeconds();boolean current();
    void withCurrentMutation(Mutation operation) throws Exception;
  }
  @FunctionalInterface public interface Verifier {boolean verify(String author,byte[] canonicalHash,String signature);}
  public interface Durability {
    void syncFile(FileOutputStream stream)throws Exception;
    void syncDirectory(File directory)throws Exception;
    void replace(File staged,File target)throws Exception;
  }
  private static final Durability SYSTEM=new Durability(){
    public void syncFile(FileOutputStream stream)throws Exception{stream.getFD().sync();}
    public void syncDirectory(File directory)throws Exception{var fd=Os.open(directory.getPath(),OsConstants.O_RDONLY|OsConstants.O_CLOEXEC|OsConstants.O_NOFOLLOW,0);try{if(!OsConstants.S_ISDIR(Os.fstat(fd).st_mode))throw new IOException();Os.fsync(fd);}finally{Os.close(fd);}}
    public void replace(File staged,File target)throws Exception{Os.rename(staged.getPath(),target.getPath());}
  };
  enum Stage { STAGED, FILE_SYNCED, RENAMED, DIRECTORY_SYNCED, LEDGER_APPENDED }
  @FunctionalInterface interface Fault {void at(Stage stage)throws Exception;}
  static final class IoPorts {
    final Durability durability;final Fault fault;
    IoPorts(Durability durability,Fault fault){this.durability=durability;this.fault=fault;}
  }
  public static final class Limits {
    public final long events,blobs,ledger;public final int count;
    public Limits(){this(EVENT_BYTES,EVENT_COUNT,BLOB_BYTES,LEDGER_BYTES);}
    public Limits(long events,int count,long blobs,long ledger){if(events<1||events>EVENT_BYTES||count<1||count>EVENT_COUNT||blobs<1||blobs>BLOB_BYTES||ledger<64||ledger>LEDGER_BYTES||ledger%64!=0)throw fail(Code.INVALID);this.events=events;this.count=count;this.blobs=blobs;this.ledger=ledger;}
  }
  public static final class EventHeader {
    public final String id,author,signature;public final long createdAt;public final int kind;
    public EventHeader(String id,String author,long createdAt,int kind,String signature){this.id=id;this.author=author;this.createdAt=createdAt;this.kind=kind;this.signature=signature;}
  }
  public static final class EventBody {
    public final String content;private final List<List<String>> tags;
    public EventBody(String content,List<List<String>> tags){this.content=content;if(content==null||content.length()>FRAME_BYTES||tags==null||tags.size()>256)throw fail(Code.INVALID);List<List<String>> copied=new ArrayList<>();for(List<String> row:tags){if(row==null||row.size()>64||row.stream().anyMatch(v->v==null||v.length()>FRAME_BYTES))throw fail(Code.INVALID);copied.add(Collections.unmodifiableList(new ArrayList<>(row)));}this.tags=Collections.unmodifiableList(copied);}
  }
  public static final class FilterWindow {
    public final Long since,until,limit;
    public FilterWindow(Long since,Long until,Long limit){this.since=since;this.until=until;this.limit=limit;}
  }
  public final class Event {
    public final String id,author,content,signature,canonical,wire;public final long createdAt;public final int kind;public final Long expiration;
    public final List<List<String>> tags;
    private Event(EventHeader header,EventBody bodyInput){
      String id=header.id,author=header.author,content=bodyInput.content,signature=header.signature;long created=header.createdAt;int kind=header.kind;List<List<String>> tags=bodyInput.tags;
      if(!hex(id)||!hex(author)||!safe(created)||kind<0||kind>65535||content==null||signature==null||!signature.matches("[0-9a-f]{128}")||tags==null||tags.size()>256)throw fail(Code.INVALID);
      this.id=id;this.author=author;createdAt=created;this.kind=kind;this.content=content;this.signature=signature;
      String body=quote(content);long budget=body.getBytes(StandardCharsets.UTF_8).length+2;List<List<String>> copied=new ArrayList<>();List<String> encoded=new ArrayList<>();Long expires=null;
      for(List<String> tag:tags){if(tag==null||tag.size()>64)throw fail(Code.INVALID);List<String> fields=new ArrayList<>(),values=new ArrayList<>();budget+=3;
        for(String field:tag){if(field==null)throw fail(Code.INVALID);String value=quote(field);budget+=value.getBytes(StandardCharsets.UTF_8).length+1;if(budget>FRAME_BYTES)throw fail(Code.INVALID);values.add(field);fields.add(value);}
        if(!tag.isEmpty()&&"expiration".equals(tag.get(0))){if(expires!=null||tag.size()!=2||!tag.get(1).matches("[0-9]{1,16}"))throw fail(Code.INVALID);expires=Long.parseLong(tag.get(1));if(!safe(expires))throw fail(Code.INVALID);}
        copied.add(Collections.unmodifiableList(values));encoded.add("["+join(fields)+"]");
      }
      this.tags=Collections.unmodifiableList(copied);expiration=expires;String encodedTags="["+join(encoded)+"]";
      canonical="[0,"+quote(author)+","+created+","+kind+","+encodedTags+","+body+"]";
      if(!encode(hash(canonical.getBytes(StandardCharsets.UTF_8))).equals(id))throw fail(Code.INVALID);
      wire="{\"id\":"+quote(id)+",\"pubkey\":"+quote(author)+",\"created_at\":"+created+",\"kind\":"+kind+",\"tags\":"+encodedTags+",\"content\":"+body+",\"sig\":"+quote(signature)+"}";
      if(("[\"EVENT\","+wire+"]").getBytes(StandardCharsets.UTF_8).length>FRAME_BYTES)throw fail(Code.INVALID);
    }
    public boolean ephemeral(){return kind>=20000&&kind<=29999;}
    private boolean live(long wall){return expiration==null||wall<expiration;}
    private NativeMeshStore owner(){return NativeMeshStore.this;}
  }
  public static final class Filter {
    private final Set<String> ids,authors;private final Set<Integer> kinds;private final Map<String,Set<String>> tags;
    public final Long since,until;public final int limit;
    public Filter(List<String> ids,List<String> authors,List<Integer> kinds,Map<String,List<String>> tags,FilterWindow window){
      if(window==null)throw fail(Code.INVALID);Long since=window.since,until=window.until,limit=window.limit;
      this.ids=strings(ids,true);this.authors=strings(authors,true);this.kinds=kinds==null?null:new HashSet<>(kinds);
      if(kinds!=null&&(kinds.isEmpty()||kinds.size()>64||kinds.stream().anyMatch(n->n==null||n<0||n>65535)))throw fail(Code.INVALID);
      if(since!=null&&!safe(since)||until!=null&&!safe(until)||since!=null&&until!=null&&since>until||limit!=null&&!safe(limit))throw fail(Code.INVALID);
      this.since=since;this.until=until;this.limit=limit==null?32:(int)Math.min(32,limit);Map<String,Set<String>> copied=new HashMap<>();
      if(tags!=null){if(tags.size()>52)throw fail(Code.INVALID);for(var item:tags.entrySet()){String key=item.getKey();if(key==null||!key.matches("#[a-zA-Z]"))throw fail(Code.INVALID);if(item.getValue()==null)throw fail(Code.INVALID);copied.put(key.substring(1),strings(item.getValue(),"#e".equals(key)||"#p".equals(key)));}}
      this.tags=Collections.unmodifiableMap(copied);
    }
    private boolean matches(Event e,boolean stored){
      if(stored&&limit==0||ids!=null&&!ids.contains(e.id)||authors!=null&&!authors.contains(e.author)||kinds!=null&&!kinds.contains(e.kind)||since!=null&&e.createdAt<since||until!=null&&e.createdAt>until)return false;
      for(var item:tags.entrySet()){boolean found=false;for(var tag:e.tags)if(tag.size()>1&&tag.get(0).equals(item.getKey())&&item.getValue().contains(tag.get(1))){found=true;break;}if(!found)return false;}return true;
    }
  }
  /** Pure bounded per-sub dedup; the coordinator separately fences source/current and EOSE delivery. */
  public static final class DeliveryCursor {
    private final List<Filter> filters;private final int maximum;private final Set<String> seen=new HashSet<>();
    public DeliveryCursor(List<Filter> filters,int maximum){this.filters=filters(filters);if(maximum<1||maximum>EVENT_COUNT)throw fail(Code.INVALID);this.maximum=maximum;}
    public synchronized boolean accept(Event event,boolean stored,long wall){if(event==null||!safe(wall)||!event.live(wall)||stored&&event.ephemeral()||filters.stream().noneMatch(f->f.matches(event,stored))||seen.contains(event.id))return false;if(seen.size()>=maximum)throw fail(Code.FULL);seen.add(event.id);return true;}
  }
  public enum Kept { DURABLE, DUPLICATE, EPHEMERAL }
  private final File directory,events,blobs,index,ledger,lockFile;
  private final String account;private final Verifier verifier;private final Durability durability;private final Fault fault;private final Limits limits;
  private final ReentrantLock operationLock=new ReentrantLock();
  private volatile boolean closed,poisoned;private IdIndex forwarded=new IdIndex();private long ledgerLength=-1;
  private NativeMeshStore(File root,String account,Verifier verifier,Durability durability,Limits limits,Fault fault)throws IOException{
    if(!hex(account)||verifier==null||durability==null||limits==null||fault==null)throw fail(Code.INVALID);this.account=account;this.verifier=verifier;this.durability=durability;this.limits=limits;this.fault=fault;
    directory=new File(root.getCanonicalFile(),account);events=new File(directory,"events");blobs=new File(directory,"blobs");index=new File(directory,"shared");ledger=new File(directory,"forward.bin");lockFile=new File(directory,"lock");
  }
  public static NativeMeshStore open(File root,Owner owner,Verifier verifier,boolean initialize,Limits limits){return open(root,owner,verifier,initialize,limits,new IoPorts(SYSTEM,stage->{}));}
  static NativeMeshStore open(File root,Owner owner,Verifier verifier,boolean initialize,Limits limits,IoPorts ports){
    try{if(root==null||owner==null||ports==null)throw fail(Code.INVALID);NativeMeshStore store=new NativeMeshStore(root,owner.account(),verifier,ports.durability,limits,ports.fault);Access access=store.new Access(owner);
      try{access.check();if(!store.directory.exists()){
        if(!initialize)throw fail(Code.UNAVAILABLE);
        owner.withCurrentMutation(()->{access.check();if(!root.isDirectory())throw new IOException();access.changed=true;if(!store.directory.mkdir()||!store.events.mkdir()||!store.blobs.mkdir()||!store.index.mkdir())throw new IOException();store.atomic(access,new File(store.directory,"format"),store.header("HGMS1"));store.atomic(access,store.ledger,store.header("HGML1"));store.durability.syncDirectory(root);access.check();});
      }
      store.operation(owner,a->{store.requireDirectory(store.directory);store.requireDirectory(store.events);store.requireDirectory(store.blobs);store.requireDirectory(store.index);if(!Arrays.equals(store.read(a,new File(store.directory,"format"),64),store.header("HGMS1")))throw fail(Code.UNAVAILABLE);store.loadLedger(a);return null;});return store;
      }catch(Failure failure){throw new Failure(failure.code,failure.mutationUnknown||access.changed);}catch(Exception failure){throw new Failure(Code.UNAVAILABLE,access.changed);}
    }catch(Failure failure){throw failure;}catch(Exception failure){throw new Failure(Code.UNAVAILABLE,false);}
  }
  private final class Access {
    final Owner owner;final long deadline;long last=-1;boolean revoked,changed;
    Access(Owner owner){if(owner==null||!account.equals(owner.account()))throw fail(Code.DENIED);this.owner=owner;deadline=owner.originalDeadlineMillis();}
    void check(){boolean current=owner.current();String ownerAccount=owner.account();long now=owner.monotonicMillis();if(revoked||closed||!current||!account.equals(ownerAccount)||now<0||now<last||now>=deadline){revoked=true;throw new Failure(Code.DENIED,changed);}last=now;if(poisoned)throw new Failure(Code.UNAVAILABLE,changed);}
    long wall(){check();long result=owner.wallSeconds();check();if(!safe(result))throw new Failure(Code.DENIED,changed);return result;}
  }
  @FunctionalInterface private interface Work<T>{T run(Access access)throws Exception;}
  private <T>T operation(Owner owner,Work<T> work){
    Access a=new Access(owner);a.check();
    while(!operationLock.tryLock()){a.check();try{Thread.sleep(10);}catch(InterruptedException failure){Thread.currentThread().interrupt();throw new Failure(Code.DENIED,false);}}
    try{return lockedOperation(a,work);}finally{operationLock.unlock();}
  }
  private <T>T lockedOperation(Access a,Work<T> work){
    try(RandomAccessFile file=new RandomAccessFile(checked(lockFile),"rw");FileChannel channel=file.getChannel()){
      FileLock lock=null;while(lock==null){a.check();try{lock=channel.tryLock();}catch(OverlappingFileLockException busy){/* another same-process native worker */}if(lock==null)Thread.sleep(10);}
      try{a.check();T result=work.run(a);a.check();return result;}finally{lock.release();}
    }catch(Failure failure){if(failure.code==Code.UNAVAILABLE)poisoned=true;throw new Failure(failure.code,failure.mutationUnknown||a.changed);}catch(InterruptedException failure){Thread.currentThread().interrupt();throw new Failure(Code.DENIED,a.changed);}catch(Exception failure){poisoned=true;throw new Failure(Code.UNAVAILABLE,a.changed);}
  }
  public Event captureVerified(Owner owner,EventHeader header,EventBody body){
    if(header==null||body==null)throw fail(Code.INVALID);Access a=new Access(owner);a.check();Event event=new Event(header,body);verify(a,event);return event;
  }
  private void verify(Access a,Event event){a.check();if(!event.live(a.wall())||!verifier.verify(event.author,decode(event.id),event.signature))throw fail(Code.INVALID);a.check();if(!event.live(a.wall()))throw new Failure(Code.INVALID,a.changed);}
  private void requireEvent(Access a,Event event){if(event==null||event.owner()!=this)throw fail(Code.INVALID);a.check();if(!event.live(a.wall()))throw new Failure(Code.INVALID,a.changed);}
  public Kept keep(Owner owner,Event event){return operation(owner,a->{requireEvent(a,event);if(event.ephemeral())return Kept.EPHEMERAL;File target=new File(events,event.id+".evt");
    if(target.exists()){Event prior=decodeEvent(a,read(a,target,RECORD_BYTES));if(!prior.id.equals(event.id))throw fail(Code.UNAVAILABLE);verify(a,prior);return Kept.DUPLICATE;}
    File[] files=list(events);long used=0;int count=0;for(File file:files){a.check();if(!file.getName().matches("[0-9a-f]{64}\\.evt"))throw fail(Code.UNAVAILABLE);used+=length(file);count++;}byte[] record=encodeEvent(event);
    if(count>=limits.count||record.length>limits.events-used)throw fail(Code.FULL);
    a.owner.withCurrentMutation(()->{requireEvent(a,event);atomic(a,target,record);requireEvent(a,event);});return Kept.DURABLE;});}
  public boolean claimForward(Owner owner,Event event){return operation(owner,a->{requireEvent(a,event);loadLedger(a);byte[] id=decode(event.id);if(forwarded.contains(id,a))return false;if(ledgerLength-header("HGML1").length>=limits.ledger)throw fail(Code.FULL);
    byte[] record=concat(id,hash(id));a.owner.withCurrentMutation(()->{requireEvent(a,event);a.changed=true;try(FileOutputStream output=new FileOutputStream(checked(ledger),true)){output.write(record);fault.at(Stage.LEDGER_APPENDED);durability.syncFile(output);}requireEvent(a,event);});
    forwarded.add(id,a);ledgerLength+=64;return true;});}
  public List<Event> backlog(Owner owner,List<Filter> input){List<Filter> requested=filters(input);return operation(owner,a->{
    Comparator<Event> newest=(x,y)->x.createdAt==y.createdAt?x.id.compareTo(y.id):Long.compare(y.createdAt,x.createdAt);
    List<PriorityQueue<Event>> queues=new ArrayList<>();for(Filter ignored:requested)queues.add(new PriorityQueue<>(32,newest.reversed()));
    long used=0;File[] files=list(events);if(files.length>limits.count)throw fail(Code.UNAVAILABLE);
    for(File file:files){a.check();if(!file.getName().matches("[0-9a-f]{64}\\.evt"))throw fail(Code.UNAVAILABLE);used+=length(file);if(used>limits.events)throw fail(Code.UNAVAILABLE);Event event=decodeEvent(a,read(a,file,RECORD_BYTES));if(!file.getName().equals(event.id+".evt")||event.ephemeral())throw fail(Code.UNAVAILABLE);if(!event.live(a.wall()))continue;
      for(int i=0;i<requested.size();i++){Filter filter=requested.get(i);if(!filter.matches(event,true))continue;PriorityQueue<Event> queue=queues.get(i);if(queue.size()<filter.limit)queue.add(event);else if(newest.compare(event,queue.peek())<0){queue.remove();queue.add(event);}}
    }
    Map<String,Event> selected=new HashMap<>();for(PriorityQueue<Event> queue:queues)for(Event event:queue)selected.put(event.id,event);
    List<Event> result=new ArrayList<>(selected.values());result.sort(newest);for(Event event:result){a.check();verify(a,event);}return Collections.unmodifiableList(result);});}
  public void shareBlob(Owner owner,String hash,byte[] input){if(!hex(hash)||input==null||input.length>limits.blobs)throw fail(Code.INVALID);byte[] bytes=input.clone();if(!encode(hash(bytes)).equals(hash))throw fail(Code.INVALID);
    operation(owner,a->{File data=new File(blobs,hash+".blob"),marker=new File(index,hash+".idx");if(marker.exists()){checkBlob(a,hash);return null;}long used=0;for(File file:list(blobs)){a.check();if(!file.getName().matches("[0-9a-f]{64}\\.blob"))throw fail(Code.UNAVAILABLE);used+=length(file);}if(data.exists())checkHash(a,data,hash,bytes.length);else if(bytes.length>limits.blobs-used)throw fail(Code.FULL);
      a.owner.withCurrentMutation(()->{a.check();if(!data.exists())atomic(a,data,bytes);checkHash(a,data,hash,bytes.length);atomic(a,marker,blobMarker(hash,bytes.length));a.check();});return null;});}
  public void unshareBlob(Owner owner,String hash){if(!hex(hash))throw fail(Code.INVALID);operation(owner,a->{File marker=new File(index,hash+".idx"),data=new File(blobs,hash+".blob");if(marker.exists())checkBlob(a,hash);
    a.owner.withCurrentMutation(()->{a.check();if(marker.exists()){a.changed=true;if(!marker.delete())throw new IOException();durability.syncDirectory(index);}a.check();if(data.exists()){a.changed=true;if(!data.delete())throw new IOException();durability.syncDirectory(blobs);}a.check();});return null;});}
  public Map<String,Integer> presence(Owner owner,List<String> hashes){if(hashes==null||hashes.size()>64||hashes.stream().anyMatch(h->!hex(h)))throw fail(Code.INVALID);List<String> snapshot=new ArrayList<>(hashes);if(snapshot.stream().anyMatch(h->!hex(h)))throw fail(Code.INVALID);return operation(owner,a->{Map<String,Integer> result=new LinkedHashMap<>();for(String h:snapshot){a.check();File marker=new File(index,h+".idx");if(marker.exists()){checkBlob(a,h);result.put(h,1);}else result.put(h,0);}return Collections.unmodifiableMap(result);});}
  private void checkBlob(Access a,String id)throws Exception{byte[] marker=read(a,new File(index,id+".idx"),160);if(marker.length!=109||!prefix(marker,header("HGMB1"))||!Arrays.equals(Arrays.copyOfRange(marker,37,69),decode(id))||!Arrays.equals(Arrays.copyOfRange(marker,77,109),hash(Arrays.copyOf(marker,77))))throw fail(Code.UNAVAILABLE);
    long size=new DataInputStream(new ByteArrayInputStream(marker,69,8)).readLong();if(size<0||size>limits.blobs)throw fail(Code.UNAVAILABLE);checkHash(a,new File(blobs,id+".blob"),id,size);}
  private void checkHash(Access a,File file,String expected,long size)throws Exception{if(length(file)!=size)throw fail(Code.UNAVAILABLE);MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream input=new BufferedInputStream(new FileInputStream(checked(file)))){byte[] chunk=new byte[16384];int n;while((n=input.read(chunk))!=-1){a.check();digest.update(chunk,0,n);}}if(!encode(digest.digest()).equals(expected))throw fail(Code.UNAVAILABLE);a.check();}
  private byte[] blobMarker(String id,long size)throws IOException{ByteArrayOutputStream b=new ByteArrayOutputStream();DataOutputStream o=new DataOutputStream(b);o.write(header("HGMB1"));o.write(decode(id));o.writeLong(size);o.flush();return concat(b.toByteArray(),hash(b.toByteArray()));}
  private void loadLedger(Access a)throws Exception{
    long size=length(ledger),headerSize=header("HGML1").length;if(size==ledgerLength)return;if(size<headerSize||(size-headerSize)%64!=0||size-headerSize>limits.ledger)throw fail(Code.UNAVAILABLE);IdIndex loaded=new IdIndex();
    try(DataInputStream input=new DataInputStream(new BufferedInputStream(new FileInputStream(checked(ledger))))){byte[] head=new byte[(int)headerSize];input.readFully(head);if(!Arrays.equals(head,header("HGML1")))throw fail(Code.UNAVAILABLE);byte[] row=new byte[64];for(long p=headerSize;p<size;p+=64){a.check();input.readFully(row);byte[] id=Arrays.copyOf(row,32);if(!Arrays.equals(Arrays.copyOfRange(row,32,64),hash(id))||loaded.contains(id,a))throw fail(Code.UNAVAILABLE);loaded.add(id,a);}}forwarded=loaded;ledgerLength=size;
  }
  private byte[] encodeEvent(Event event)throws IOException{ByteArrayOutputStream b=new ByteArrayOutputStream();DataOutputStream o=new DataOutputStream(b);o.write(header("HGME1"));o.write(decode(event.id));o.write(decode(event.author));o.writeLong(event.createdAt);o.writeInt(event.kind);o.write(decode(event.signature));writeText(o,event.content);o.writeInt(event.tags.size());for(var tag:event.tags){o.writeInt(tag.size());for(String value:tag)writeText(o,value);}o.flush();byte[] bytes=b.toByteArray();if(bytes.length+32>RECORD_BYTES)throw fail(Code.INVALID);return concat(bytes,hash(bytes));}
  private Event decodeEvent(Access a,byte[] bytes)throws Exception{
    if(bytes.length<177||!prefix(bytes,header("HGME1"))||!Arrays.equals(Arrays.copyOfRange(bytes,bytes.length-32,bytes.length),hash(Arrays.copyOf(bytes,bytes.length-32))))throw fail(Code.UNAVAILABLE);
    try(DataInputStream input=new DataInputStream(new ByteArrayInputStream(bytes,37,bytes.length-37-32))){byte[] id=new byte[32],author=new byte[32],sig=new byte[64];input.readFully(id);input.readFully(author);long created=input.readLong();int kind=input.readInt();input.readFully(sig);String content=readText(input);int count=input.readInt();if(count<0||count>256)throw fail(Code.UNAVAILABLE);List<List<String>> tags=new ArrayList<>();for(int i=0;i<count;i++){a.check();int fields=input.readInt();if(fields<0||fields>64)throw fail(Code.UNAVAILABLE);List<String> tag=new ArrayList<>();for(int j=0;j<fields;j++)tag.add(readText(input));tags.add(tag);}if(input.available()!=0)throw fail(Code.UNAVAILABLE);try{return new Event(new EventHeader(encode(id),encode(author),created,kind,encode(sig)),new EventBody(content,tags));}catch(RuntimeException bad){throw fail(Code.UNAVAILABLE);}}
  }
  private void atomic(Access a,File target,byte[] bytes)throws Exception{
    a.check();checked(target);File temp=new File(target.getParentFile(),".tmp-"+UUID.randomUUID());boolean moved=false;
    try{try(FileOutputStream output=new FileOutputStream(temp)){output.write(bytes);fault.at(Stage.STAGED);a.check();durability.syncFile(output);fault.at(Stage.FILE_SYNCED);a.check();}a.changed=true;durability.replace(temp,target);moved=true;fault.at(Stage.RENAMED);a.check();durability.syncDirectory(target.getParentFile());fault.at(Stage.DIRECTORY_SYNCED);a.check();if(!Arrays.equals(read(a,target,bytes.length),bytes))throw new IOException();}
    finally{if(!moved&&temp.exists()&&!temp.delete())poisoned=true;}
  }
  private byte[] read(Access a,File file,int maximum)throws Exception{long n=length(file);if(n<0||n>maximum)throw fail(Code.UNAVAILABLE);ByteArrayOutputStream output=new ByteArrayOutputStream((int)n);try(InputStream input=new FileInputStream(checked(file))){byte[] chunk=new byte[16384];int count;while((count=input.read(chunk))!=-1){a.check();if(output.size()+count>maximum)throw fail(Code.UNAVAILABLE);output.write(chunk,0,count);}}a.check();return output.toByteArray();}
  private File checked(File file)throws IOException{File real=file.getCanonicalFile();if(!real.equals(file.getAbsoluteFile()))throw new IOException("Unexpected Mesh path");return real;}
  private void requireDirectory(File file)throws IOException{if(!checked(file).isDirectory())throw new IOException();}
  private File[] list(File file)throws IOException{requireDirectory(file);File[] files=file.listFiles();if(files==null)throw new IOException();return files;}
  private long length(File file)throws IOException{if(!checked(file).isFile())throw new IOException();return file.length();}
  private byte[] header(String magic){return concat(magic.getBytes(StandardCharsets.US_ASCII),decode(account));}
  private static void writeText(DataOutputStream output,String value)throws IOException{byte[] bytes=value.getBytes(StandardCharsets.UTF_8);output.writeInt(bytes.length);output.write(bytes);}
  private static String readText(DataInputStream input)throws IOException{int n=input.readInt();if(n<0||n>FRAME_BYTES||n>input.available())throw new IOException();byte[] bytes=new byte[n];input.readFully(bytes);try{return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString();}catch(CharacterCodingException invalid){throw new IOException(invalid);}}
  private static List<Filter> filters(List<Filter> values){if(values==null)throw fail(Code.INVALID);List<Filter> snapshot=new ArrayList<>(values);if(snapshot.isEmpty()||snapshot.size()>4||snapshot.contains(null))throw fail(Code.INVALID);return Collections.unmodifiableList(snapshot);}
  private static Set<String> strings(List<String> values,boolean hexadecimal){if(values==null)return null;if(values.isEmpty()||values.size()>64)throw fail(Code.INVALID);Set<String> copied=new HashSet<>();for(String value:values){if(value==null||hexadecimal&&!hex(value)||!StandardCharsets.UTF_8.newEncoder().canEncode(value)||value.getBytes(StandardCharsets.UTF_8).length>1024)throw fail(Code.INVALID);copied.add(value);}return Collections.unmodifiableSet(copied);}
  private static boolean hex(String value){return value!=null&&value.matches("[0-9a-f]{64}");}
  private static boolean safe(long value){return value>=0&&value<=9_007_199_254_740_991L;}
  private static String quote(String value){try{return NativeCanonicalJSON.INSTANCE.quote(value);}catch(RuntimeException failure){throw fail(Code.INVALID);}}
  private static String join(List<String> values){StringBuilder out=new StringBuilder();for(String value:values){if(out.length()>0)out.append(',');out.append(value);}return out.toString();}
  private static byte[] hash(byte[] bytes){try{return MessageDigest.getInstance("SHA-256").digest(bytes);}catch(Exception failure){throw fail(Code.UNAVAILABLE);}}
  private static String encode(byte[] bytes){StringBuilder out=new StringBuilder(bytes.length*2);for(byte value:bytes){int n=value&255;out.append("0123456789abcdef".charAt(n>>>4)).append("0123456789abcdef".charAt(n&15));}return out.toString();}
  private static byte[] decode(String value){byte[] out=new byte[value.length()/2];for(int i=0;i<out.length;i++)out[i]=(byte)(Character.digit(value.charAt(i*2),16)*16+Character.digit(value.charAt(i*2+1),16));return out;}
  private static byte[] concat(byte[] a,byte[] b){byte[] result=Arrays.copyOf(a,a.length+b.length);System.arraycopy(b,0,result,a.length,b.length);return result;}
  private static boolean prefix(byte[] value,byte[] head){return value.length>=head.length&&Arrays.equals(Arrays.copyOf(value,head.length),head);}
  private static Failure fail(Code code){return new Failure(code,false);}
  /** Compact exact index: <=32MiB IDs +8MiB slots at default full ledger, no ID eviction. */
  private static final class IdIndex {
    byte[] ids=new byte[32*16];int[] slots=new int[32];int count;
    int code(byte[] id){int value=1;for(byte b:id)value=31*value+(b&255);return value;}
    int slot(byte[] id,Access access){int slot=code(id)&(slots.length-1);for(int n=0;n<slots.length;n++){if((n&255)==0)access.check();int value=slots[slot];if(value==0)return slot;boolean same=true;for(int j=0;j<32;j++)if(ids[(value-1)*32+j]!=id[j]){same=false;break;}if(same)return slot;slot=(slot+1)&(slots.length-1);}throw fail(Code.FULL);}
    boolean contains(byte[] id,Access access){return slots[slot(id,access)]!=0;}
    void add(byte[] id,Access access){
      if(contains(id,access))return;
      if(count==ids.length/32){ids=Arrays.copyOf(ids,ids.length*2);slots=new int[slots.length*2];byte[] previous=new byte[32];for(int i=0;i<count;i++){if((i&255)==0)access.check();System.arraycopy(ids,i*32,previous,0,32);slots[slot(previous,access)]=i+1;}}
      System.arraycopy(id,0,ids,count*32,32);slots[slot(id,access)]=++count;
    }
  }
  @Override public void close(){closed=true;}
}
