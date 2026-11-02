package org.nostrocket.hypergolic.signercore;

/** Pure ticket tuple/episode/result-gate proof; no browser or RPC authentication claim. */
public final class NativeHandoffTicketProof {
  private static int assertions;
  private static void check(boolean value) { assertions++; if(!value)throw new AssertionError("Ticket assertion "+assertions); }
  public static int run() {
    assertions=0; Object owner=new Object(), operation=new Object();
    NativeHandoffTicket ticket=new NativeHandoffTicket(owner,operation,7,1000,"native-request-a");
    check("pending".equals(ticket.state(owner,operation,100)));
    check(ticket.state(new Object(),operation,100)==null); check(ticket.state(owner,new Object(),100)==null);
    check(!ticket.resume(owner,operation,100));
    ticket.background(); ticket.background();
    check("pending".equals(ticket.state(owner,operation,100))); check(!ticket.resume(owner,operation,100));
    ticket.foreground(); check(!ticket.resume(owner,new Object(),100)); check(!ticket.resume(owner,operation,100));
    check(!ticket.verifiedResult(owner,operation,"wrong-id",100));
    check(ticket.verifiedResult(owner,operation,"native-request-a",100)); check(ticket.resume(owner,operation,100));
    check(ticket.originalEpoch==7); check(ticket.requestId.equals("native-request-a")); check("resumed".equals(ticket.state(owner,operation,100)));
    check(!ticket.resume(owner,operation,100)); ticket.background(); check(ticket.state(owner,operation,100)==null);
    NativeHandoffTicket next=new NativeHandoffTicket(owner,operation,8,1000,"native-request-b");
    ticket.cancel(); check("pending".equals(next.state(owner,operation,100))); check(next.requestId.equals("native-request-b"));
    next.background(); next.foreground(); next.background(); check(next.state(owner,operation,100)==null);
    next=new NativeHandoffTicket(owner,operation,9,1000,"native-request-c");
    check(next.state(owner,operation,1000)==null); check(!next.resume(owner,operation,1000));
    next.cancel(); check(next.state(owner,operation,100)==null);
    return assertions;
  }
  public static void main(String[] args) { System.out.println("{\"status\":\"passed\",\"assertions\":"+run()+"}"); }
}
