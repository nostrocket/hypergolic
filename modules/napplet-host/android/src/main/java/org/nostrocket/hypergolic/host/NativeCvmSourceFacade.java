package org.nostrocket.hypergolic.host;

import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** App-only native permit handoff; no Expo argument can construct an Access. */
public final class NativeCvmSourceFacade {
  public interface Access {
    String token(); String generation(); String provider(); String message();
    List<String> relays(); long deadline(); Object registration(); boolean initialize();
    boolean current(); boolean sourceCurrent(); boolean consume(String message, String relay);
  }
  public interface Observer { void cancel(); void completed(String permit); }
  private static final class Watch {
    final Access access; final Observer observer;
    Watch(Access access, Observer observer) { this.access=access; this.observer=observer; }
  }
  private static final Map<String,Access> permits=new LinkedHashMap<>();
  private static final Map<String,Watch> watchers=new LinkedHashMap<>();
  private NativeCvmSourceFacade() {}
  static synchronized void install(Access access) { if(permits.size()>=4||permits.putIfAbsent(access.token(),access)!=null)throw new IllegalStateException("CVM permit unavailable"); }
  public static Access acquire(String token) {
    Access access; synchronized(NativeCvmSourceFacade.class){access=permits.get(token);}
    if(access==null||!access.current())throw new IllegalStateException("CVM permit unavailable");return access;
  }
  public static synchronized void watch(String session,Access access,Observer observer) {
    if(watchers.size()>=2||watchers.containsKey(session))throw new IllegalStateException("CVM session unavailable");
    watchers.put(session,new Watch(access,observer));
  }
  public static synchronized void unwatch(String session) { watchers.remove(session); }
  static void completed(String token) {
    List<Watch> copy; synchronized(NativeCvmSourceFacade.class){copy=new ArrayList<>(watchers.values());}
    for(Watch watch:copy)try{watch.observer.completed(token);}catch(RuntimeException|Error failure){try{watch.observer.cancel();}catch(RuntimeException|Error ignored){/* Other exact sessions must still revoke. */}}
    synchronized(NativeCvmSourceFacade.class){permits.remove(token);}
  }
  static void cancel(String token) {
    List<Watch> copy;
    synchronized(NativeCvmSourceFacade.class){permits.remove(token);copy=new ArrayList<>(watchers.values());}
    for(Watch watch:copy)if(watch.access.token().equals(token))try{watch.observer.cancel();}catch(RuntimeException|Error ignored){/* Other requests remain independent. */}
  }
  static void cancelSource(String generation,String provider) {
    List<Watch> copy; synchronized(NativeCvmSourceFacade.class){copy=new ArrayList<>(watchers.values());}
    for(Watch watch:copy)if(watch.access.generation().equals(generation)&&(provider==null||watch.access.provider().equals(provider)))try{watch.observer.cancel();}catch(RuntimeException|Error ignored){/* Revocation continues for remaining exact sessions. */}
  }
  static void cancelAll() {
    List<Watch> copy; synchronized(NativeCvmSourceFacade.class){permits.clear();copy=new ArrayList<>(watchers.values());}
    for(Watch watch:copy)try{watch.observer.cancel();}catch(RuntimeException|Error ignored){/* Revocation continues for remaining exact sessions. */}
  }
}
