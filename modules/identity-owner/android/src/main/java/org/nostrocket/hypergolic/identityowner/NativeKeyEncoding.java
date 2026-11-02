package org.nostrocket.hypergolic.identityowner;

import java.util.Arrays;

/** Native NIP-19 text handling. No Expo method accepts or returns these values. */
public final class NativeKeyEncoding {
  private static final String ALPHABET="qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  private static final int[] GENERATOR={0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3};
  private NativeKeyEncoding() {}
  public static char[] encode(byte[] scalar) { return BackupNsec.encode(scalar); }
  public static byte[] decode(char[] text) {
    int[] data=new int[58]; byte[] scalar=new byte[32];
    try {
      if (text==null || text.length!=63) throw new IllegalArgumentException();
      boolean lower=false,upper=false;
      for(char c:text) { if(c>127) throw new IllegalArgumentException(); if(c>='a'&&c<='z')lower=true; if(c>='A'&&c<='Z')upper=true; }
      if(lower&&upper)throw new IllegalArgumentException();
      char[] prefix={'n','s','e','c','1'};
      for(int i=0;i<5;i++)if(Character.toLowerCase(text[i])!=prefix[i])throw new IllegalArgumentException();
      int checksum=1;
      for(char c:new char[]{3,3,3,3,0,14,19,5,3})checksum=step(checksum,c);
      for(int i=0;i<data.length;i++) { int value=ALPHABET.indexOf(Character.toLowerCase(text[i+5])); if(value<0)throw new IllegalArgumentException();data[i]=value;checksum=step(checksum,value); }
      if(checksum!=1)throw new IllegalArgumentException();
      int bits=0,accumulator=0,index=0;
      for(int i=0;i<52;i++) { accumulator=(accumulator<<5)|data[i];bits+=5;if(bits>=8) { bits-=8;if(index>=32)throw new IllegalArgumentException();scalar[index++]=(byte)(accumulator>>>bits); } }
      if(index!=32 || bits!=4 || (accumulator&15)!=0)throw new IllegalArgumentException();
      BackupNsec.requireScalar(scalar); return scalar;
    } catch(RuntimeException failure) { Arrays.fill(scalar,(byte)0);throw new IllegalArgumentException("Invalid private key"); }
    finally { Arrays.fill(data,0); }
  }
  private static int step(int checksum,int value) {
    int top=checksum>>>25; checksum=((checksum&0x1ffffff)<<5)^value;
    for(int i=0;i<5;i++)if(((top>>>i)&1)!=0)checksum^=GENERATOR[i];return checksum;
  }
}
