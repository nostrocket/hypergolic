package org.nostrocket.hypergolic.host;
import java.util.*;
import java.util.function.LongSupplier;
/** A committed handoff receipt survives background, never generation revocation. */
public final class LinkLeaseRegistry {
  private static final class Session {final String user; final long epoch; boolean focused; final ArrayDeque<Long> attempts = new ArrayDeque<>(); Session(String user,long epoch){this.user=user;this.epoch=epoch;}}
  private static final class Entry {final String generation; final long expires; boolean dispatched; Entry(String g, long t) {generation=g; expires=t;}}
  private final LongSupplier clock;
  private final Map<String, Session> sessions = new HashMap<>();
  private final Map<String, Entry> requests = new HashMap<>();
  private final ArrayDeque<Long> global = new ArrayDeque<>();
  private boolean foreground;
  private String owner; private long epoch=-1; private boolean available;
  public LinkLeaseRegistry(LongSupplier clock) {this.clock=clock;}
  public synchronized boolean register(String generation, String user, long epoch) {
    if (sessions.containsKey(generation)) {Session s=sessions.get(generation); return s.user.equals(user) && s.epoch==epoch;}
    if (sessions.size() >= 64) return false;
    sessions.put(generation, new Session(user,epoch)); return true;
  }
  private boolean owns(Session s) {return s!=null && available && Objects.equals(owner,s.user) && epoch==s.epoch;}
  public synchronized List<String> synchronizeOwner(String user,long nextEpoch,boolean ready) {
    if(nextEpoch<epoch || nextEpoch==epoch && owner!=null && !owner.equals(user)) return null;
    boolean changed=!Objects.equals(owner,user) || epoch!=nextEpoch;
    owner=user; epoch=nextEpoch; available=ready;
    List<String> tokens=!ready||changed?cancel(null,true):Collections.emptyList();
    if(changed) sessions.entrySet().removeIf(e->!Objects.equals(e.getValue().user,user)||e.getValue().epoch!=nextEpoch);
    return tokens;
  }
  private void prune(ArrayDeque<Long> values, long now) {while (!values.isEmpty() && now-values.peekFirst() >= 60_000) values.removeFirst();}
  public synchronized boolean canDeliver(String generation) {return owns(sessions.get(generation));}
  public synchronized String admit(String generation) {
    long now=clock.getAsLong(); Session s=sessions.get(generation);
    if (!foreground || !owns(s) || !s.focused) return null;
    prune(s.attempts,now); prune(global,now);
    if (!requests.isEmpty() || s.attempts.size()>=3 || global.size()>=12) return null;
    s.attempts.addLast(now); global.addLast(now);
    String token=UUID.randomUUID().toString(); requests.put(token,new Entry(generation,now+25_000)); return token;
  }
  public synchronized boolean claim(String token) {
    Entry e=requests.get(token); Session s=e==null?null:sessions.get(e.generation);
    if (e==null || !owns(s) || e.dispatched || clock.getAsLong()>=e.expires || !foreground || !s.focused) return false;
    e.dispatched=true; return true;
  }
  public synchronized boolean finish(String token) {
    Entry e=requests.remove(token); Session s=e==null?null:sessions.get(e.generation);
    return e!=null && owns(s) && clock.getAsLong()<e.expires && (e.dispatched || foreground&&s.focused);
  }
  public synchronized List<String> focus(String generation, boolean value) {
    Session s=sessions.get(generation); if (s!=null) s.focused=value;
    return value?Collections.emptyList():cancel(generation,false);
  }
  public synchronized List<String> foreground(boolean value) {foreground=value; return value?Collections.emptyList():cancel(null,false);}
  public synchronized List<String> revoke(String generation) {sessions.remove(generation); return cancel(generation,true);}
  public synchronized List<String> expire() {
    ArrayList<String> expired=new ArrayList<>(); long now=clock.getAsLong();
    requests.entrySet().removeIf(e->{if(now>=e.getValue().expires){expired.add(e.getKey());return true;}return false;}); return expired;
  }
  private List<String> cancel(String generation, boolean all) {
    ArrayList<String> revoked=new ArrayList<>();
    requests.entrySet().removeIf(e->{Entry v=e.getValue();if((generation==null||generation.equals(v.generation))&&(all||!v.dispatched)){revoked.add(e.getKey());return true;}return false;});return revoked;
  }
}
