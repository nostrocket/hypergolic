package org.nostrocket.hypergolic.host;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
public final class LiveMP3BufferProof {
  private static int checks;
  private interface Action { void run() throws Exception; }
  private static void check(boolean v) { if (!v) throw new AssertionError();checks++; }
  private static void denied(Action r) throws Exception { try { r.run();throw new AssertionError(); } catch (IOException expected) { checks++; } }
  private static byte[] frame(int third) {
    int length=144000*new int[]{0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0}[third>>4]/new int[]{44100,48000,32000}[(third>>2)&3]+((third>>1)&1);
    byte[] bytes=new byte[length];bytes[0]=(byte)255;bytes[1]=(byte)251;bytes[2]=(byte)third;bytes[3]=(byte)196;return bytes;
  }
  private static void feed(LiveMP3Gate gate,byte[] bytes,int size) throws IOException {
    for(int offset=0;offset<bytes.length;offset+=size){int n=Math.min(size,bytes.length-offset);gate.append(Arrays.copyOfRange(bytes,offset,offset+n),n);}
  }
  public static void main(String[] args) throws Exception {
    byte[] frame=frame(0x90);
    for(int size:new int[]{1,3,4,7,417,8192}) {
      ByteArrayOutputStream received=new ByteArrayOutputStream();LiveMP3Gate gate=new LiveMP3Gate((b,n)->received.write(b,0,n));
      feed(gate,frame,size);feed(gate,frame(0x50),size);gate.finish();check(received.size()==frame.length+frame(0x50).length);
    }
    byte[] id3=new byte[65536];System.arraycopy(new byte[]{73,68,51,4,0,0,0,3,(byte)127,(byte)118},0,id3,0,10);
    // Declared size65526 is the exact aggregate64KiB initial metadata boundary.
    int size=65526;for(int i=9;i>=6;i--){id3[i]=(byte)(size&127);size>>=7;}
    LiveMP3Gate exact=new LiveMP3Gate((b,n)->{});feed(exact,id3,8192);feed(exact,frame,417);exact.finish();checks++;
    LiveMP3Gate tooBig=new LiveMP3Gate((b,n)->{});byte[] bigger=id3.clone();bigger[9]++;denied(()->feed(tooBig,bigger,8192));
    LiveMP3Gate partial=new LiveMP3Gate((b,n)->{});feed(partial,Arrays.copyOf(frame,416),100);denied(partial::finish);
    LiveMP3Gate changed=new LiveMP3Gate((b,n)->{});feed(changed,frame,417);denied(()->feed(changed,frame(0x94),384));
    LiveMP3Gate middle=new LiveMP3Gate((b,n)->{});feed(middle,frame,417);denied(()->feed(middle,new byte[]{73,68,51,4,0,0,0,0,0,0},10));
    denied(()->feed(new LiveMP3Gate((b,n)->{}),new byte[]{'<','h','t','m','l','>','x','x','x','x'},10));
    LiveMP3Buffer buffer=new LiveMP3Buffer(8,2,()->{});byte[] out=new byte[12];
    buffer.append(new byte[]{1,2,3,4,5,6,7,8},8);check(buffer.read(0,out,0,8)==2);check(buffer.read(2,out,2,6)==6);
    buffer.append(new byte[]{9,10,11,12},4);check(buffer.read(0,out,0,2)==2&&out[0]==1);denied(()->buffer.read(2,out,0,1));
    check(buffer.read(8,out,8,4)==4&&out[11]==12);buffer.finish();check(buffer.read(12,out,0,1)==-1);denied(()->buffer.append(new byte[1],1));
    LiveMP3Buffer blocked=new LiveMP3Buffer(2,0,()->{});AtomicBoolean cancelled=new AtomicBoolean();
    Thread consumer=new Thread(()->{try{blocked.read(0,new byte[1],0,1);}catch(IOException e){cancelled.set(true);}});
    consumer.start();Thread.sleep(20);blocked.cancel();consumer.join(300);check(!consumer.isAlive()&&cancelled.get());
    LiveMP3Buffer full=new LiveMP3Buffer(2,0,()->{});full.append(new byte[2],2);AtomicBoolean producerCancelled=new AtomicBoolean();
    Thread producer=new Thread(()->{try{full.append(new byte[1],1);}catch(IOException e){producerCancelled.set(true);}});
    producer.start();Thread.sleep(20);full.cancel();producer.join(300);check(!producer.isAlive()&&producerCancelled.get());
    System.out.println("LiveMP3BufferProof: "+checks+" checks passed");
  }
}
