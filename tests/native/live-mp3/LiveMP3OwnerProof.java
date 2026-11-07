package org.nostrocket.hypergolic.host;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicLong;
public final class LiveMP3OwnerProof {
  private static int checks;
  private interface Action { void run() throws Exception; }
  private static void check(boolean v) { if (!v) throw new AssertionError(); checks++; }
  private static void denied(Action r) throws Exception { try { r.run();throw new AssertionError(); } catch (IOException expected) { checks++; } }
  public static void main(String[] args) throws Exception {
    AtomicLong clock=new AtomicLong();String scope="user:epoch:generation:publisher:app:version";
    LiveMP3Owner finite=new LiveMP3Owner(null,scope,clock::get,1000);
    denied(()->finite.nativePlay(scope,"review",true,true));
    LiveMP3Owner owner=new LiveMP3Owner(LiveMP3Owner.PROFILE,scope,clock::get,1000);
    denied(()->owner.nativePlay(scope,"review",false,true));denied(()->owner.nativePlay(scope,"review",true,false));
    denied(()->owner.nativePlay("differentidentity", "review",true,true));
    check(owner.phase()==LiveMP3Owner.Phase.OFFERED);long first=owner.nativePlay(scope,"review",true,true);
    owner.check(first,scope,"review",true,true);checks++;
    denied(()->owner.check(first,scope,"newfocusrevision",true,true));
    denied(()->owner.check(first,scope,"review",false,true));
    denied(()->owner.check(first,"newgeneration","review",true,true));
    owner.output(first);check(owner.phase()==LiveMP3Owner.Phase.PLAYING);owner.budget(first).charge(100);
    LiveMP3Owner second=new LiveMP3Owner(LiveMP3Owner.PROFILE,scope,clock::get,1000);
    denied(()->second.nativePlay(scope,"review",true,true));
    owner.pause();check(owner.phase()==LiveMP3Owner.Phase.STOPPING);
    denied(()->owner.check(first,scope,"review",true,true));
    owner.drained(first,true);denied(()->second.nativePlay(scope,"review",true,true));
    owner.drained(first,false);check(owner.phase()==LiveMP3Owner.Phase.PAUSED);
    clock.set(500);long resumed=owner.nativePlay(scope,"freshreview",true,true);
    check(owner.budget(resumed).received()==100&&owner.budget(resumed).remainingMillis()==500);
    denied(()->owner.check(first,scope,"freshreview",true,true));
    owner.drained(first,true);denied(()->second.nativePlay(scope,"review",true,true));
    clock.set(1000);denied(()->owner.check(resumed,scope,"freshreview",true,true));
    check(owner.retire());check(!owner.retire());owner.drained(resumed,true);
    denied(()->second.nativePlay(scope,"review",true,true));owner.drained(resumed,false);
    long next=second.nativePlay(scope,"review",true,true);check(next>0);second.retire();second.drained(next,true);second.drained(next,false);
    denied(()->owner.nativePlay(scope,"review",true,true));
    AtomicLong expiryClock=new AtomicLong();LiveMP3Owner expiryRace=new LiveMP3Owner(LiveMP3Owner.PROFILE,scope,expiryClock::get,100);
    long expired=expiryRace.nativePlay(scope,"review",true,true);expiryClock.set(100);expiryRace.pause();
    check(expiryRace.phase()==LiveMP3Owner.Phase.ENDED);check("policy".equals(expiryRace.reason()));
    check(expiryRace.takeTerminal()==null);expiryRace.drained(expired,true);check(expiryRace.takeTerminal()==null);
    expiryRace.drained(expired,false);check("policy".equals(expiryRace.takeTerminal()));check(expiryRace.takeTerminal()==null);
    check(!expiryRace.retire());check(expiryRace.takeTerminal()==null);
    AtomicLong setupClock=new AtomicLong();LiveMP3Owner setup=new LiveMP3Owner(LiveMP3Owner.PROFILE,scope,setupClock::get,100);
    long setupToken=setup.nativePlay(scope,"review",true,true);setupClock.set(100);
    try {setup.budget(setupToken).remainingMillis();throw new AssertionError();}
    catch(IOException expiredDuringArming){setup.drained(setupToken,true);setup.retire("error");setup.drained(setupToken,false);}
    check("error".equals(setup.takeTerminal()));check(setup.drained());
    Object finitePlayer=new Object();check(MediaPlaybackReservation.acquire(finitePlayer));
    LiveMP3Owner live=new LiveMP3Owner(LiveMP3Owner.PROFILE,scope,new AtomicLong()::get,1000);
    denied(()->live.nativePlay(scope,"review",true,true));
    MediaPlaybackReservation.draining(finitePlayer);denied(()->live.nativePlay(scope,"review",true,true));
    MediaPlaybackReservation.release(new Object());denied(()->live.nativePlay(scope,"review",true,true));
    MediaPlaybackReservation.release(finitePlayer);long liveToken=live.nativePlay(scope,"review",true,true);
    check(!MediaPlaybackReservation.acquire(finitePlayer));live.retire("user");live.drained(liveToken,false);
    check(!MediaPlaybackReservation.acquire(finitePlayer));live.drained(liveToken,true);
    check("user".equals(live.takeTerminal()));check(MediaPlaybackReservation.acquire(finitePlayer));MediaPlaybackReservation.release(finitePlayer);
    LiveMP3Owner unknown=new LiveMP3Owner(LiveMP3Owner.PROFILE,scope,new AtomicLong()::get,1000);
    long unknownToken=unknown.nativePlay(scope,"review",true,true);unknown.retain(new Object());unknown.uncertainCleanup();
    check("backend-exited".equals(unknown.takeTerminal()));check(unknown.takeTerminal()==null);
    check(!unknown.retire("user"));unknown.drained(unknownToken,true);unknown.drained(unknownToken,false);
    check(!unknown.drained());check(!MediaPlaybackReservation.acquire(finitePlayer));
    check(MediaPlaybackReservation.hint().contains("Restart Hypergolic"));
    System.out.println("LiveMP3OwnerProof: "+checks+" checks passed");
  }
}
