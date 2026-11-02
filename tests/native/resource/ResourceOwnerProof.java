package org.nostrocket.hypergolic.host;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

public final class ResourceOwnerProof {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
  private static void denied(Action action, String code) throws Exception {
    try { action.run(); throw new AssertionError("Expected " + code); }
    catch (ResourceHttpsRequestOwner.Failure failure) { check(code.equals(failure.code)); }
  }
  private interface Action { void run() throws Exception; }
  public static void main(String[] args) throws Exception {
    AtomicLong time = new AtomicLong(100);
    CapabilityLeaseRegistry leases = new CapabilityLeaseRegistry(time::get);
    check(leases.register("generation"));
    String token = leases.admit("generation",1,"immutable");
    check(leases.borrowedSnapshot(token) == null); check("immutable".equals(leases.take(token)));
    check("immutable".equals(leases.borrowedSnapshot(token))); check(leases.take(token) == null);
    byte[] body = new byte[3 * 1024 * 1024]; body[body.length-1]=73;
    ResourceHttpsRequestOwner owner = new ResourceHttpsRequestOwner((url,cancel)->body.clone());
    String id = UUID.randomUUID().toString();
    denied(()->owner.fetch(id,token,"generation","https://cdn.example.com/a",()->leases.isActive(token),()->true),"blocked-by-policy");
    owner.setForeground(true);
    check(owner.fetch(id,token,"generation","https://cdn.example.com/a",()->leases.isActive(token),()->true)==body.length);
    denied(()->owner.read(id,"foreign",0),"blocked-by-policy");
    denied(()->owner.read(id,token,1),"invalid-request");
    for(int offset=0;offset<body.length;offset+=ResourceHttpsRequestOwner.CHUNK_BYTES) {
      byte[] chunk=owner.read(id,token,offset);check(chunk.length==ResourceHttpsRequestOwner.CHUNK_BYTES);
      if(offset+chunk.length==body.length)check(chunk[chunk.length-1]==73);
    }
    denied(()->owner.read(id,token,0),"blocked-by-policy");
    denied(()->owner.fetch(id,token,"generation","https://cdn.example.com/a",()->leases.isActive(token),()->true),"invalid-request");
    String cancelled=UUID.randomUUID().toString();owner.cancel(cancelled);
    denied(()->owner.fetch(cancelled,token,"generation","https://cdn.example.com/a",()->leases.isActive(token),()->true),"invalid-request");
    String[] ids=new String[4];
    for(int i=0;i<4;i++){ids[i]=UUID.randomUUID().toString();check(owner.fetch(ids[i],token,"generation","https://cdn.example.com/a",()->leases.isActive(token),()->true)==body.length);}
    denied(()->owner.fetch(UUID.randomUUID().toString(),token,"generation","https://cdn.example.com/a",()->leases.isActive(token),()->true),"quota-exceeded");
    leases.revoke("generation");owner.revokeGeneration("generation");
    for(String value:ids)denied(()->owner.read(value,token,0),"blocked-by-policy");
    check(leases.borrowedSnapshot(token)==null);check(leases.register("next"));
    String next=leases.admit("next",1,"next-snapshot");check(leases.take(next)!=null);
    String waiting=UUID.randomUUID().toString();owner.fetch(waiting,next,"next","https://cdn.example.com/a",()->leases.isActive(next),()->true);
    time.addAndGet(25_000);check(leases.borrowedSnapshot(next)==null);
    denied(()->owner.read(waiting,next,0),"blocked-by-policy");
    byte[] header=("HTTP/1.1 200 OK\r\nContent-Length: "+body.length+"\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
    byte[] wire=new byte[header.length+body.length];System.arraycopy(header,0,wire,0,header.length);System.arraycopy(body,0,wire,header.length,body.length);
    try { PublishedHttpsResponseReader.read(new ByteArrayInputStream(wire),()->false);throw new AssertionError("Published ceiling changed"); }
    catch(PublishedHttpsResponseReader.ResourceFailure failure){check("too-large".equals(failure.code));}
    check(PublishedHttpsResponseReader.readBounded(new ByteArrayInputStream(wire),()->false,ResourceHttpsRequestOwner.MAX_BYTES).length==body.length);
    byte[] huge="HTTP/1.1 200 OK\r\nContent-Length: 10485761\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
    try{PublishedHttpsResponseReader.readBounded(new ByteArrayInputStream(huge),()->false,ResourceHttpsRequestOwner.MAX_BYTES);throw new AssertionError("Oversize accepted");}
    catch(PublishedHttpsResponseReader.ResourceFailure failure){check("too-large".equals(failure.code));}
    byte[] repeated="HTTP/1.1 200 OK\r\nContent-Length: 1\r\nX-Goog-Hash: crc32c=fixture\r\nX-Goog-Hash: md5=fixture\r\n\r\na".getBytes(StandardCharsets.US_ASCII);
    check(PublishedHttpsResponseReader.readBounded(new ByteArrayInputStream(repeated),()->false,ResourceHttpsRequestOwner.MAX_BYTES).length==1);
    for(String name:new String[]{"Content-Length","Transfer-Encoding","Content-Encoding","Connection"}) {
      byte[] duplicate=("HTTP/1.1 200 OK\r\nContent-Length: 1\r\n"+name+": one\r\n"+name+": two\r\n\r\na").getBytes(StandardCharsets.US_ASCII);
      try{PublishedHttpsResponseReader.readBounded(new ByteArrayInputStream(duplicate),()->false,ResourceHttpsRequestOwner.MAX_BYTES);throw new AssertionError("Ambiguous header accepted");}
      catch(java.io.IOException expected){check(true);}
    }
    byte[] duplicateRedirect="HTTP/1.1 302 Redirect\r\nLocation: https://one.example.com/a\r\nLocation: https://one.example.com/a\r\nContent-Length: 0\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
    try{PublishedHttpsResponseReader.readBounded(new ByteArrayInputStream(duplicateRedirect),()->false,ResourceHttpsRequestOwner.MAX_BYTES);throw new AssertionError("Duplicate redirect accepted");}
    catch(PublishedHttpsResponseReader.ResourceRedirect invalid){throw new AssertionError("Ambiguous redirect followed");}
    catch(java.io.IOException expected){check(true);}
    System.out.println("{\"language\":\"Java\",\"resourceOwnerChecks\":"+checks+",\"failed\":0}");
  }
}
