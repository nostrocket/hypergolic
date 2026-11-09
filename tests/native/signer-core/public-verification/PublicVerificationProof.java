package org.nostrocket.hypergolic.signercore;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public final class PublicVerificationProof {
  static int checks;static int number;
  static String id(){return String.format("00000000-0000-4000-8000-%012d",++number);}
  static void ok(boolean value){checks++;if(!value)throw new AssertionError("proof "+checks);}
  static void denied(Runnable action){try{action.run();throw new AssertionError("expected denial");}catch(IllegalStateException expected){checks++;}}
  static String tuple(String p,String d,String s){return "[[\""+p+"\",\""+d+"\",\""+s+"\"]]";}
  public static void main(String[] args)throws Exception{
    String raw=Files.readString(Path.of(args[0]));
    NativePublicVerification real=new NativePublicVerification();
    for(String line:Files.readAllLines(Path.of(args[1]))){String[] f=line.split("\t");String operation=id();String result=real.run(real.begin(operation,tuple(f[0],f[1],f[2]),1000,()->true));ok(result.contains("\"operationId\":\""+operation+"\""));ok(result.contains("["+f[3].toLowerCase()+"]"));}
    String zero="0".repeat(64),signature="0".repeat(128),one=tuple(zero,zero,signature);
    NativePublicVerification owner=new NativePublicVerification(()->0,(p,d,s)->true);
    for(String bad:new String[]{"[]","[1]",one+" ",one.replace("0000","zzzz"),"["+String.join(",",Collections.nCopies(201,one.substring(1,one.length()-1)))+"]"}){
      NativePublicVerification.Job job=owner.begin(id(),bad,1000,()->true);denied(()->owner.run(job));
    }
    denied(()->owner.begin(id(),"x".repeat(65_537),1000,()->true));
    NativePublicVerification.Job edge=owner.begin(id(),"x".repeat(65_536),1000,()->true);denied(()->owner.run(edge));
    String full="["+String.join(",",Collections.nCopies(200,one.substring(1,one.length()-1)))+"]";
    ok(full.length()==53_401);ok(owner.run(owner.begin(id(),full,1000,()->true)).contains("true,true"));
    String cancelled=id();owner.cancel(cancelled);denied(()->owner.begin(cancelled,one,1000,()->true));
    NativePublicVerification.Job abandoned=owner.begin(id(),one,1000,()->true);owner.abandon(abandoned);denied(()->owner.run(abandoned));
    NativePublicVerification.Job paused=owner.begin(id(),one,1000,()->true);owner.foreground(false);owner.foreground(true);denied(()->owner.run(paused));
    AtomicBoolean active=new AtomicBoolean(true);NativePublicVerification.Job stale=owner.begin(id(),one,1000,active::get);active.set(false);denied(()->owner.run(stale));
    AtomicLong clock=new AtomicLong();NativePublicVerification timed=new NativePublicVerification(clock::get,(p,d,s)->{clock.set(1_000_000);return true;});
    NativePublicVerification.Job deadline=timed.begin(id(),one,1,()->true);denied(()->timed.run(deadline));
    CountDownLatch entered=new CountDownLatch(2),release=new CountDownLatch(1);AtomicInteger exits=new AtomicInteger();
    NativePublicVerification blocked=new NativePublicVerification(System::nanoTime,(p,d,s)->{entered.countDown();try{release.await();}catch(InterruptedException e){throw new AssertionError(e);}return true;});
    var a=blocked.begin(id(),one,15000,()->true);var b=blocked.begin(id(),one,15000,()->true);
    Runnable worker=()->{try{blocked.run(Thread.currentThread().getName().equals("a")?a:b);throw new AssertionError("cancelled work returned");}catch(IllegalStateException expected){exits.incrementAndGet();}};
    Thread ta=new Thread(worker,"a"),tb=new Thread(worker,"b");ta.start();tb.start();ok(entered.await(2,TimeUnit.SECONDS));
    blocked.cancel(a.id);blocked.close();denied(()->owner.begin(id(),one,1000,()->true));release.countDown();ta.join();tb.join();ok(exits.get()==2);
    ok(owner.run(owner.begin(id(),one,1000,()->true)).contains("true"));
    var resumed=owner.begin(id(),one,1000,()->true);owner.run(resumed);owner.foreground(false);owner.foreground(true);denied(()->owner.delivery(resumed));
    var completed=owner.begin(id(),one,1000,()->true);owner.run(completed);owner.cancel(completed.id);denied(()->owner.delivery(completed));
    var overflow=owner.begin(id(),one,1000,()->true);owner.run(overflow);
    for(int i=0;i<64;i++)owner.cancel(id());owner.cancel(overflow.id);denied(()->owner.delivery(overflow));
    double total=0;for(int round=0;round<9;round++){long start=System.nanoTime();String result=real.run(real.begin(id(),raw,15000,()->true));double ms=(System.nanoTime()-start)/1e6;ok(!result.contains("false"));if(round>=2)total+=ms;}
    System.out.println("{\"checks\":"+checks+",\"events\":80,\"nativeOwnerParseHexJNIAndSchnorrMeanMs\":"+(total/7)+",\"scope\":\"macOS host actual JNI/C, no Expo bridge/device claim\"}");
  }
}
