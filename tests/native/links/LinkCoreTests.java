package org.nostrocket.hypergolic.host;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;
public final class LinkCoreTests {
  static int count=0;
  static void check(boolean value) {if(!value) throw new AssertionError("Link core case "+count); count++;}
  public static void main(String[] args) throws Exception {
    for(String line:Files.readAllLines(Path.of(args[0]))) {String[] parts=line.split("\t",-1);String url=new String(Base64.getDecoder().decode(parts[0]),java.nio.charset.StandardCharsets.UTF_8);String actual=LinkUrl.error(url);check(Objects.equals(actual,parts[1].equals("ok")?null:parts[1]));}
    check(LinkUrl.displayIdentity("signed-resource-link-lab").equals("signed-resource-link-lab"));
    check(LinkUrl.displayIdentity("消息 🚀").equals("消息 🚀"));
    check(LinkUrl.displayIdentity("app\nPublisher: fake\u202E\u2028\u2066").equals("app\\u000APublisher: fake\\u202E\\u2028\\u2066"));
    AtomicLong now=new AtomicLong(); LinkLeaseRegistry r=new LinkLeaseRegistry(now::get);
    check(r.synchronizeOwner("owner",0,true)!=null);check(r.register("one","owner",0)); check(r.admit("one")==null); r.foreground(true); check(r.admit("one")==null); r.focus("one",true);
    String token=r.admit("one");check(token!=null);check(r.admit("one")==null);
    final String captured=token; AtomicInteger wins=new AtomicInteger(); ArrayList<Thread> threads=new ArrayList<>();
    for(int i=0;i<20;i++){Thread t=new Thread(()->{if(r.claim(captured))wins.incrementAndGet();});threads.add(t);t.start();}for(Thread t:threads)t.join();check(wins.get()==1);
    check(r.foreground(false).isEmpty());check(r.finish(token));check(!r.finish(token));check(r.admit("one")==null);
    r.foreground(true);token=r.admit("one");check(token!=null);check(r.focus("one",false).contains(token));check(!r.claim(token));check(!r.finish(token));r.focus("one",true);
    token=r.admit("one");check(token!=null);check(r.claim(token));check(r.revoke("one").contains(token));check(!r.finish(token));check(r.admit("one")==null);
    check(r.register("two","owner",0));r.focus("two",true);token=r.admit("two");check(token!=null);now.set(25_000);check(!r.claim(token));check(r.expire().contains(token));check(!r.finish(token));check(r.canDeliver("two"));
    now.set(60_000);for(int i=0;i<3;i++){token=r.admit("two");check(token!=null);check(r.finish(token));}check(r.admit("two")==null);now.set(120_000);token=r.admit("two");check(token!=null);check(r.foreground(false).contains(token));check(!r.finish(token));
    r.foreground(true); now.set(180_000); token=r.admit("two");check(token!=null);check(r.claim(token));
    check(r.synchronizeOwner("owner",0,false).contains(token));check(!r.canDeliver("two"));check(!r.finish(token));
    check(r.synchronizeOwner("owner",0,true)!=null);check(r.canDeliver("two"));token=r.admit("two");check(token!=null);
    check(r.synchronizeOwner("other",1,true).contains(token));check(!r.canDeliver("two"));check(!r.claim(token));check(!r.finish(token));
    check(r.synchronizeOwner("owner",0,true)==null);check(r.synchronizeOwner("owner",1,true)==null);
    check(r.register("new","other",1));r.focus("new",true);check(!r.register("new","owner",0));token=r.admit("new");check(token!=null);check(r.finish(token));
    LinkLeaseRegistry bounded=new LinkLeaseRegistry(now::get);bounded.synchronizeOwner("owner",0,true);bounded.foreground(true);
    for(int n=0;n<64;n++)check(bounded.register("s"+n,"owner",0));check(!bounded.register("overflow","owner",0));
    for(int n=0;n<12;n++){String g="s"+n;bounded.focus(g,true);String t=bounded.admit(g);check(t!=null);check(bounded.finish(t));}
    bounded.focus("s12",true);check(bounded.admit("s12")==null);now.addAndGet(60_000);token=bounded.admit("s12");check(token!=null);check(bounded.finish(token));
    System.out.println("PASS Android owning link core "+count);
  }
}
