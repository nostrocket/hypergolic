package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

public final class PublishedArtifactRegistryProof {
  private static int assertions;
  private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Registry assertion " + assertions); }
  private static final String SESSION = "session_a-1";
  private static final String OTHER = "session_b-2";
  private static final String VIEW = "123e4567-e89b-12d3-a456-426614174000";
  private static final String PUBLISHER = "ab".repeat(32);
  private static final String EVENT = "cd".repeat(32);
  private static final String IDENTIFIER = "fixture-profile";

  private static final class Fixture {
    long now;
    final PublishedArtifactRegistry registry = new PublishedArtifactRegistry(() -> now, new SecureRandom());
    Fixture() { check(registry.registerSession(SESSION)); }
  }
  private static final class Claims {
    final byte[] bytes;
    final String htmlHash, aggregate;
    Claims(byte[] bytes) { this.bytes=bytes; htmlHash=hash(bytes); aggregate=hash((htmlHash+" /index.html\n").getBytes(StandardCharsets.US_ASCII)); }
    String stage(PublishedArtifactRegistry registry, String session) {
      return registry.stage(bytes, session, PUBLISHER, IDENTIFIER, EVENT, aggregate, htmlHash);
    }
    PublishedArtifactRegistry.ClaimedArtifact claim(PublishedArtifactRegistry registry, String token,
        String session, String generation) {
      return registry.claim(token, session, PUBLISHER, IDENTIFIER, EVENT, aggregate, htmlHash, generation);
    }
  }

  private static void exactIntegrityAndCopies() {
    Fixture f = new Fixture(); byte[] bytes="<!doctype html><title>fixture</title>".getBytes(StandardCharsets.UTF_8);
    Claims c = new Claims(bytes); String token=c.stage(f.registry,SESSION);
    check(token!=null && token.length()==64); check(!token.equals(c.htmlHash));
    Arrays.fill(bytes, (byte) 'x');
    PublishedArtifactRegistry.ClaimedArtifact claimed=c.claim(f.registry,token,SESSION,VIEW);
    check(claimed!=null && claimed.getViewGeneration().equals(VIEW));
    byte[] owned=claimed.takeHtmlBytes(); check(Arrays.equals(owned,"<!doctype html><title>fixture</title>".getBytes(StandardCharsets.UTF_8)));
    Arrays.fill(owned,(byte) 0); check(claimed.takeHtmlBytes()==null);
    check(c.claim(f.registry,token,SESSION,"123e4567-e89b-12d3-a456-426614174001")==null);
  }

  private static void boundsAndRealHashes() {
    Fixture f=new Fixture();
    byte[] exact=new byte[PublishedArtifactRegistry.MAX_HTML_BYTES]; Arrays.fill(exact,(byte)' ');
    Claims c=new Claims(exact); String token=c.stage(f.registry,SESSION);
    check(token!=null); check(c.claim(f.registry,token,SESSION,VIEW)!=null);
    byte[] oversized=new byte[PublishedArtifactRegistry.MAX_HTML_BYTES+1];
    check(new Claims(oversized).stage(f.registry,SESSION)==null);
    check(f.registry.stage(new byte[0],SESSION,PUBLISHER,IDENTIFIER,EVENT,"00".repeat(32),"00".repeat(32))==null);
    byte[] content="<p>real hash</p>".getBytes(StandardCharsets.UTF_8); Claims valid=new Claims(content);
    check(f.registry.stage(content,SESSION,PUBLISHER,IDENTIFIER,EVENT,"00".repeat(32),valid.htmlHash)==null);
    check(f.registry.stage(content,SESSION,PUBLISHER,IDENTIFIER,EVENT,valid.aggregate,"00".repeat(32))==null);
    check(f.registry.stage(content,SESSION.toUpperCase(),PUBLISHER,IDENTIFIER,EVENT,valid.aggregate,valid.htmlHash)==null);
    check(f.registry.stage(content,SESSION,PUBLISHER.toUpperCase(),IDENTIFIER,EVENT,valid.aggregate,valid.htmlHash)==null);
    check(f.registry.stage(content,SESSION,PUBLISHER,IDENTIFIER,EVENT.toUpperCase(),valid.aggregate,valid.htmlHash)==null);
  }

  private static void strictUtf8AndInputValidation() throws Exception {
    Fixture f=new Fixture(); byte[] malformed={(byte)0xc3,(byte)0x28}; Claims invalid=new Claims(malformed);
    check(f.registry.stage(malformed,SESSION,PUBLISHER,IDENTIFIER,EVENT,invalid.aggregate,invalid.htmlHash)==null);
    byte[] good="ok".getBytes(StandardCharsets.UTF_8); Claims c=new Claims(good);
    check(f.registry.stage(good,"",PUBLISHER,IDENTIFIER,EVENT,c.aggregate,c.htmlHash)==null);
    check(!f.registry.registerSession("session.with.dot"));
    check(!f.registry.registerSession("x".repeat(81)));
    check(f.registry.registerSession("session_ok-1"));
    check(f.registry.stage(good,SESSION,PUBLISHER,"\n",EVENT,c.aggregate,c.htmlHash)==null);
    check(f.registry.stage(good,SESSION,PUBLISHER," ",EVENT,c.aggregate,c.htmlHash)==null);
    check(f.registry.stage(good,SESSION,PUBLISHER,IDENTIFIER,EVENT,"g".repeat(64),c.htmlHash)==null);
  }

  private static void exactClaimsAndCrossSession() {
    Fixture f=new Fixture(); check(f.registry.registerSession(OTHER)); byte[] bytes="payload".getBytes(StandardCharsets.UTF_8); Claims c=new Claims(bytes);
    String token=c.stage(f.registry,SESSION); check(token!=null);
    check(c.claim(f.registry,token,OTHER,VIEW)==null);
    check(c.claim(f.registry,token,SESSION,VIEW)==null);

    token=c.stage(f.registry,SESSION); check(token!=null);
    check(f.registry.claim(token,SESSION,"33".repeat(32),IDENTIFIER,EVENT,c.aggregate,c.htmlHash,VIEW)==null);
    check(c.claim(f.registry,token,SESSION,VIEW)==null);
    token=c.stage(f.registry,SESSION);
    check(f.registry.claim(token,SESSION,PUBLISHER,"changed",EVENT,c.aggregate,c.htmlHash,VIEW)==null);
    check(c.claim(f.registry,token,SESSION,VIEW)==null);
    token=c.stage(f.registry,SESSION);
    check(f.registry.claim(token,SESSION,PUBLISHER,IDENTIFIER,"44".repeat(32),c.aggregate,c.htmlHash,VIEW)==null);
    check(c.claim(f.registry,token,SESSION,VIEW)==null);
    token=c.stage(f.registry,SESSION);
    check(f.registry.claim(token,SESSION,PUBLISHER,IDENTIFIER,EVENT,"55".repeat(32),c.htmlHash,VIEW)==null);
    check(c.claim(f.registry,token,SESSION,VIEW)==null);
    token=c.stage(f.registry,SESSION);
    check(f.registry.claim(token,SESSION,PUBLISHER,IDENTIFIER,EVENT,c.aggregate,"66".repeat(32),VIEW)==null);
    check(c.claim(f.registry,token,SESSION,VIEW)==null);
    token=c.stage(f.registry,SESSION);
    check(f.registry.claim(token,SESSION,PUBLISHER,IDENTIFIER,EVENT,c.aggregate,c.htmlHash,"not-a-uuid")==null);
    check(c.claim(f.registry,token,SESSION,VIEW)==null);
    token=c.stage(f.registry,SESSION); check(c.claim(f.registry,token,SESSION,VIEW)!=null);
    check(c.claim(f.registry,token,SESSION,VIEW)==null);
  }

  private static void boundedExpiryAndRevocation() {
    Fixture f=new Fixture(); byte[] bytes="pending".getBytes(StandardCharsets.UTF_8); Claims c=new Claims(bytes);
    String[] tokens=new String[PublishedArtifactRegistry.MAX_PENDING];
    for(int i=0;i<tokens.length;i++){tokens[i]=c.stage(f.registry,SESSION); check(tokens[i]!=null);}
    check(c.stage(f.registry,SESSION)==null);
    f.registry.revokeSession(SESSION); check(c.claim(f.registry,tokens[0],SESSION,VIEW)==null);
    check(c.stage(f.registry,SESSION)==null); check(f.registry.registerSession(SESSION));
    check(c.stage(f.registry,SESSION)!=null);

    Fixture expiry=new Fixture(); String expiring=c.stage(expiry.registry,SESSION); check(expiring!=null);
    expiry.now=PublishedArtifactRegistry.MAX_LIFETIME_MS-1; check(c.claim(expiry.registry,expiring,SESSION,VIEW)!=null);
    String exactExpiry=c.stage(expiry.registry,SESSION); check(exactExpiry!=null);
    expiry.now+=PublishedArtifactRegistry.MAX_LIFETIME_MS; check(c.claim(expiry.registry,exactExpiry,SESSION,VIEW)==null);

    Fixture all=new Fixture(); String allToken=c.stage(all.registry,SESSION); check(allToken!=null);
    all.registry.revokeAll(); check(c.claim(all.registry,allToken,SESSION,VIEW)==null);
    check(c.stage(all.registry,SESSION)==null); check(all.registry.registerSession(SESSION));
    check(c.stage(all.registry,SESSION)!=null);
  }

  private static void defaultMonotonicClockRegisters() {
    PublishedArtifactRegistry registry=new PublishedArtifactRegistry();
    check(registry.registerSession("default-clock"));
  }

  private static void concurrentClaimIsOneUse() throws Exception {
    Fixture f=new Fixture(); Claims c=new Claims("race".getBytes(StandardCharsets.UTF_8)); String token=c.stage(f.registry,SESSION);
    CountDownLatch start=new CountDownLatch(1); AtomicInteger success=new AtomicInteger();
    Runnable claim=()->{try{start.await(); if(c.claim(f.registry,token,SESSION,VIEW)!=null) success.incrementAndGet();}
      catch(InterruptedException e){Thread.currentThread().interrupt();throw new AssertionError(e);}};
    Thread one=new Thread(claim),two=new Thread(claim); one.start(); two.start(); start.countDown(); one.join(); two.join();
    check(success.get()==1);
  }

  private static String hash(byte[] bytes) {
    try {
      byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder out=new StringBuilder();
      for(byte value:digest) out.append(String.format("%02x",value&0xff)); return out.toString();
    } catch(Exception e){throw new IllegalStateException(e);}
  }
  public static void main(String[] args) throws Exception {
    exactIntegrityAndCopies(); boundsAndRealHashes(); strictUtf8AndInputValidation();
    exactClaimsAndCrossSession(); boundedExpiryAndRevocation(); defaultMonotonicClockRegisters();
    concurrentClaimIsOneUse();
    System.out.println("{\"status\":\"passed\",\"assertions\":"+assertions+"}");
  }
}
