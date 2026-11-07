package org.nostrocket.hypergolic.host;
import java.io.ByteArrayInputStream;
import java.net.Socket;
public final class CvmReadTurnProof {
  static final class OwnedSocket extends Socket {int timeout;@Override public void setSoTimeout(int value){timeout=value;}}
  public static void main(String[]args)throws Exception{
    OwnedSocket socket=new OwnedSocket();var deadline=PublishedRelayWssQuery.Deadline.atElapsed(10000,()->1000L);
    var input=new PublishedRelayWssIo.DeadlineInput(new ByteArrayInputStream(new byte[]{1,2}),socket,deadline);
    byte[] bytes=new byte[1];if(input.read(bytes,0,1)!=1||socket.timeout!=3000)throw new AssertionError("ordinary timeout changed");
    if(input.readWithTimeout(bytes,0,1,100)!=1||socket.timeout!=100)throw new AssertionError("CVM turn unbounded");
    for(int invalid:new int[]{0,3001}){try{input.readWithTimeout(bytes,0,1,invalid);throw new AssertionError("invalid read cap");}catch(java.io.IOException expected){}}
    System.out.println("{\"checks\":4,\"scope\":\"actual existing accounted input: ordinary3000 unchanged, CVM100ms turn/invalid bounds\"}");
  }
}
