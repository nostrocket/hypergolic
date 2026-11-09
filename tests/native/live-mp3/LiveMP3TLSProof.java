package org.nostrocket.hypergolic.host;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import org.nostrocket.hypergolic.host.PublishedHttpsTlsProof.LocalServer;

/** Same production transport; only explicit package-private test DNS/trust seams reach owned loopback. */
public final class LiveMP3TLSProof {
  private static int checks;
  private static final InetAddress LOOP;
  static { try { LOOP=InetAddress.getByAddress(new byte[]{127,0,0,1}); } catch(IOException e){throw new ExceptionInInitializerError(e);} }
  private static final PublishedHttpsTransport.AddressPolicy POLICY=new PublishedHttpsTransport.AddressPolicy(){
    public boolean isAllowedHost(String host){return true;}
    public boolean isAllowedAddress(InetAddress address){return address.isLoopbackAddress()||PublicAddressPolicy.accepts(address.getAddress());}
  };
  private interface Action {void run()throws Exception;}
  private static void check(boolean value){if(!value)throw new AssertionError();checks++;}
  private static void denied(Action run)throws Exception{try{run.run();throw new AssertionError("Expected denial");}catch(IOException expected){checks++;}}
  private static String url(LocalServer server){return "https://napplets.example.org:"+server.port()+"/radio";}
  private static byte[] frame(){byte[] f=new byte[417];f[0]=(byte)255;f[1]=(byte)251;f[2]=(byte)144;f[3]=(byte)196;return f;}
  private static byte[] wire(String head,byte[] body)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(head.getBytes(StandardCharsets.US_ASCII));out.write(body);return out.toByteArray();}
  private static byte[] read(LocalServer server,ThreadPoolExecutor dns,SSLSocketFactory trust,PublishedHttpsTransport.HostResolver resolver,
      PublishedHttpsTransport.Cancellation cancellation,LiveMP3Budget budget)throws IOException{
    ByteArrayOutputStream out=new ByteArrayOutputStream();LiveMP3Gate gate=new LiveMP3Gate((b,n)->out.write(b,0,n));budget.beginAttempt();
    LiveMP3HTTPS.streamWithTransport(url(server),POLICY,cancellation,budget,gate,resolver,dns,trust,PublishedHttpsTlsProof.PROOF_HOSTNAME_VERIFIER);
    gate.finish();return out.toByteArray();
  }
  public static void main(String[] args)throws Exception{
    SSLContext context=PublishedHttpsTlsProof.serverContext(Path.of(args[1]));SSLSocketFactory trust=PublishedHttpsTlsProof.trustedFactory(Path.of(args[0]));
    ThreadPoolExecutor dns=new ThreadPoolExecutor(1,1,0L,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(4));
    byte[] frame=frame();String head="HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\n";
    try{
      ByteArrayOutputStream complete=new ByteArrayOutputStream();complete.write((head+"Transfer-Encoding: chunked\r\n\r\n1a1\r\n").getBytes(StandardCharsets.US_ASCII));complete.write(frame);complete.write("\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
      try(LocalServer server=new LocalServer(context,complete.toByteArray(),false)){
        check(Arrays.equals(frame,read(server,dns,trust,h->new InetAddress[]{LOOP},()->false,new LiveMP3Budget())));
        check(server.request.contains("\r\nAccept: audio/mpeg\r\nIcy-MetaData: 0\r\n"));check(!server.request.contains("Authorization:")&&!server.request.contains("Cookie:"));
        check(server.request.contains("User-Agent: Hypergolic-LiveMP3/1.0 (https://github.com/nostrocket/hypergolic)"));
      }
      byte[] fixed=wire(head+"Content-Length: 417\r\n\r\n",frame);
      try(LocalServer server=new LocalServer(context,fixed,false)){
        LiveMP3Budget exact=new LiveMP3Budget(()->System.nanoTime()/1_000_000L,fixed.length,5000);
        check(Arrays.equals(frame,read(server,dns,trust,h->new InetAddress[]{LOOP},()->false,exact)));check(exact.received()==fixed.length);
      }
      try(LocalServer server=new LocalServer(context,wire(head+"Content-Length: 417\r\n\r\n",Arrays.copyOf(frame,418)),false)){
        LiveMP3Budget exact=new LiveMP3Budget(()->System.nanoTime()/1_000_000L,fixed.length,5000);
        denied(()->read(server,dns,trust,h->new InetAddress[]{LOOP},()->false,exact));check(exact.received()==fixed.length);
      }
      AtomicInteger resolutions=new AtomicInteger();
      try(LocalServer last=new LocalServer(context,wire(head+"Content-Length: 417\r\n\r\n",frame),false);
          LocalServer first=new LocalServer(context,"HTTP/1.1 302 Found\r\nLocation: "+url(last)+"\r\n\r\n",false)){
        LiveMP3Budget budget=new LiveMP3Budget();check(Arrays.equals(frame,read(first,dns,trust,h->{resolutions.incrementAndGet();return new InetAddress[]{LOOP};},()->false,budget)));
        check(resolutions.get()==2&&budget.received()>417);check(first.requestCount==1&&last.requestCount==1);
      }
      for(String location:new String[]{"http://napplets.example.org/live","https://127.0.0.1/live","https://user@napplets.example.org/live","https://printer.local/live"}){
        AtomicInteger calls=new AtomicInteger();
        try(LocalServer first=new LocalServer(context,"HTTP/1.1 302 Found\r\nLocation: "+location+"\r\n\r\n",false)){
          denied(()->read(first,dns,trust,h->{calls.incrementAndGet();return new InetAddress[]{LOOP};},()->false,new LiveMP3Budget()));check(calls.get()==1);
        }
      }
      try(LocalServer first=new LocalServer(context,"HTTP/1.1 302 Found\r\nLocation: /radio\r\n\r\n",false)){
        denied(()->read(first,dns,trust,h->new InetAddress[]{LOOP},()->false,new LiveMP3Budget()));check(first.requestCount==1);
      }
      try(LocalServer first=new LocalServer(context,wire(head+"\r\n",frame),false)){
        denied(()->read(first,dns,trust,h->new InetAddress[]{LOOP,InetAddress.getByAddress(new byte[]{10,0,0,1})},()->false,new LiveMP3Budget()));check(first.accepted==0);
      }
      AtomicBoolean cancelled=new AtomicBoolean();
      try(LocalServer first=new LocalServer(context,wire(head+"\r\n",frame),true)){
        FutureTask<Boolean> pending=new FutureTask<>(()->{try{read(first,dns,trust,h->new InetAddress[]{LOOP},cancelled::get,new LiveMP3Budget());return false;}catch(IOException e){return true;}});
        Thread thread=new Thread(pending);thread.setDaemon(true);thread.start();check(first.requestArrived.await(2,TimeUnit.SECONDS));cancelled.set(true);check(pending.get(2,TimeUnit.SECONDS));
      }
      try(LocalServer first=new LocalServer(context,wire(head+"\r\n",frame),false)){
        AtomicInteger calls=new AtomicInteger();denied(()->read(first,dns,trust,h->{calls.incrementAndGet();return new InetAddress[]{LOOP};},()->true,new LiveMP3Budget()));check(calls.get()==0&&first.accepted==0);
      }
    }finally{dns.shutdownNow();check(dns.awaitTermination(2,TimeUnit.SECONDS));}
    System.out.println("LiveMP3TLSProof: "+checks+" checks passed");
  }
}
