package android.os;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.Map;
public final class Handler {
  private static final Map<Runnable,Long> timers=new IdentityHashMap<>();
  private static final java.util.ArrayDeque<Runnable> queued=new java.util.ArrayDeque<>();
  public static volatile boolean held;
  public Handler(Looper ignored){}
  public boolean post(Runnable runnable){synchronized(queued){if(held){queued.addLast(runnable);return true;}}runnable.run();return true;}
  public static int queuedCount(){synchronized(queued){return queued.size();}}
  public static void flush(){for(;;){Runnable next;synchronized(queued){next=queued.pollFirst();}if(next==null)return;next.run();}}
  public boolean postDelayed(Runnable runnable,long delay){synchronized(timers){timers.put(runnable,SystemClock.time+delay);}return true;}
  public void removeCallbacks(Runnable runnable){synchronized(timers){timers.remove(runnable);}}
  public static int count(){synchronized(timers){return timers.size();}}
  public static void due(){ArrayList<Runnable> list=new ArrayList<>();synchronized(timers){for(Map.Entry<Runnable,Long> entry:timers.entrySet())if(entry.getValue()<=SystemClock.time)list.add(entry.getKey());for(Runnable value:list)timers.remove(value);}for(Runnable value:list)value.run();}
}
