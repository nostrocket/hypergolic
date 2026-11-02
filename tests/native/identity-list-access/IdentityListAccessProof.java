import java.util.*;
import org.nostrocket.hypergolic.host.IdentityListAccessRegistry;
public final class IdentityListAccessProof {
  static int checks;
  static void check(boolean value){if(!value)throw new AssertionError("check "+checks);checks++;}
  static IdentityListAccessRegistry.Owner owner(String app){return new IdentityListAccessRegistry.Owner("1".repeat(64),"2".repeat(64),app);}
  static void rejects(Runnable action){try{action.run();throw new AssertionError("accepted invalid input");}catch(IllegalArgumentException expected){checks++;}}
  public static void main(String[] args)throws Exception{
    IdentityListAccessRegistry policy=new IdentityListAccessRegistry();var a=owner("A");var b=owner("B");long pending=policy.capture();
    check(!policy.permits(a,pending));policy.replace(List.of(a));check(policy.permits(a,pending));check(!policy.permits(b,pending));
    policy.replace(List.of(a,b));check(policy.permits(a,pending));check(policy.permits(b,pending));
    var foreignUser=new IdentityListAccessRegistry.Owner("3".repeat(64),a.publisher,a.appId);var foreignPublisher=new IdentityListAccessRegistry.Owner(a.user,"3".repeat(64),a.appId);
    check(!policy.permits(foreignUser,pending));check(!policy.permits(foreignPublisher,pending));check(!policy.permits(owner("A\u0000B"),pending));
    policy.replace(List.of(b));check(!policy.permits(a,pending));check(!policy.permits(b,pending));
    policy.replace(List.of(a,b));check(!policy.permits(a,pending));long fresh=policy.capture();check(policy.permits(a,fresh));check(policy.permits(b,fresh));
    rejects(()->policy.replace(List.of(a,a)));check(!policy.permits(a,fresh));policy.replace(List.of(a));check(!policy.permits(a,fresh));
    long latest=policy.capture();check(policy.permits(a,latest));policy.clear();check(!policy.permits(a,latest));
    rejects(()->owner(""));rejects(()->owner("雪".repeat(342)));check(owner("雪".repeat(341)).appId.length()==341);
    rejects(()->new IdentityListAccessRegistry.Owner("A".repeat(64),a.publisher,"app"));rejects(()->owner("\ud800"));
    List<IdentityListAccessRegistry.Owner> excess=new ArrayList<>();for(int i=0;i<65;i++)excess.add(owner("app-"+i));rejects(()->policy.replace(excess));
    policy.replace(List.of(a));long raced=policy.capture();Thread removal=new Thread(policy::clear);removal.start();removal.join();check(!policy.permits(a,raced));
    System.out.println("PASS native identity-list Java "+checks+" checks");
  }
}
