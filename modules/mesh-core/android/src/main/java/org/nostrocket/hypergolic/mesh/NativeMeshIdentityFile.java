package org.nostrocket.hypergolic.mesh;

import android.content.Context;
import android.os.Build;
import android.app.KeyguardManager;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** App-private AES-GCM snapshot. Host proofs exercise FileStore with real files and a test key port. */
final class NativeMeshIdentityFile {
  private static final byte[] HEADER={'H','G','M','E',1};
  interface Keys { boolean exists() throws Exception;SecretKey key(boolean create) throws Exception; }
  interface Durability { void syncFile(FileOutputStream stream)throws Exception;void replace(File source,File target)throws Exception;void syncDirectory(File directory)throws Exception; }
  static NativeMeshIdentityStore.Backend open(Context context,String account,NativeMeshIdentityStore.Current current){
    if(account==null||!account.matches("[0-9a-f]{64}"))throw new NativeMeshIdentityStore.Failure();
    try{
      KeyguardManager keyguard=(KeyguardManager)context.getSystemService(Context.KEYGUARD_SERVICE);
      NativeMeshIdentityStore.Current unlocked=()->current.current()&&keyguard!=null&&!keyguard.isDeviceLocked();
      String hash=hex(MessageDigest.getInstance("SHA-256").digest(account.getBytes(java.nio.charset.StandardCharsets.US_ASCII)));
      File directory=new File(context.getNoBackupFilesDir(),"mesh-identity-v1");if(!directory.isDirectory()&&!directory.mkdirs())throw new Exception();
      String alias="org.nostrocket.hypergolic.mesh.identity.v1."+hash;KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
      Keys keys=new Keys(){
        public boolean exists()throws Exception{return ks.containsAlias(alias);}
        public SecretKey key(boolean create)throws Exception{if(ks.containsAlias(alias)){KeyStore.Entry entry=ks.getEntry(alias,null);if(!(entry instanceof KeyStore.SecretKeyEntry))throw new Exception();return ((KeyStore.SecretKeyEntry)entry).getSecretKey();}if(!create)throw new Exception();
          KeyGenParameterSpec.Builder spec=new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true);
          if(Build.VERSION.SDK_INT>=28)spec.setUnlockedDeviceRequired(true);KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(spec.build());return generator.generateKey();}
      };
      Durability durability=new Durability(){
        public void syncFile(FileOutputStream stream)throws Exception{stream.getFD().sync();}
        public void replace(File source,File target)throws Exception{Os.rename(source.getPath(),target.getPath());}
        public void syncDirectory(File dir)throws Exception{FileDescriptor fd=Os.open(dir.getPath(),OsConstants.O_RDONLY|OsConstants.O_CLOEXEC|OsConstants.O_NOFOLLOW,0);try{if(!OsConstants.S_ISDIR(Os.fstat(fd).st_mode))throw new Exception();Os.fsync(fd);}finally{Os.close(fd);}}
      };
      return new FileStore(new Address(directory,hash,account),keys,durability,unlocked);
    }catch(Exception failure){throw new NativeMeshIdentityStore.Failure();}
  }
  static final class Address {final File directory;final String name,account;Address(File directory,String name,String account){this.directory=directory;this.name=name;this.account=account;}}
  static final class FileStore implements NativeMeshIdentityStore.Backend {
    private final File directory,file,temporary;private final Keys keys;private final Durability durability;private final NativeMeshIdentityStore.Current current;private final byte[] aad;private boolean failed;
    FileStore(Address address,Keys keys,Durability durability,NativeMeshIdentityStore.Current current){
      if(address==null)throw new NativeMeshIdentityStore.Failure();File directory=address.directory;String name=address.name,account=address.account;
      if(directory==null||!directory.isDirectory()||name==null||!name.matches("[0-9a-f]{64}")||account==null||!account.matches("[0-9a-f]{64}")||keys==null||durability==null||current==null)throw new NativeMeshIdentityStore.Failure();
      this.directory=directory;file=new File(directory,name+".bin");temporary=new File(directory,name+".new");this.keys=keys;this.durability=durability;this.current=current;
      byte[] user=account.getBytes(java.nio.charset.StandardCharsets.US_ASCII);aad=Arrays.copyOf(HEADER,HEADER.length+user.length);System.arraycopy(user,0,aad,HEADER.length,user.length);
    }
    private void active()throws Exception{if(failed||!current.current()||failed)throw new Exception();}
    public synchronized byte[] read(){byte[] encoded=null,clear=null;try{active();if(temporary.exists())throw new Exception();if(!file.exists()){if(keys.exists())throw new Exception();return null;}
      long size=file.length();if(size<HEADER.length+29||size>NativeMeshIdentityStore.MAX_BYTES+33)throw new Exception();encoded=new byte[(int)size];
      try(FileInputStream input=new FileInputStream(file)){int offset=0;while(offset<encoded.length){int n=input.read(encoded,offset,encoded.length-offset);if(n<=0)throw new Exception();offset+=n;}if(input.read()!=-1)throw new Exception();}
      for(int i=0;i<HEADER.length;i++)if(encoded[i]!=HEADER[i])throw new Exception();byte[] iv=Arrays.copyOfRange(encoded,5,17);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,keys.key(false),new GCMParameterSpec(128,iv));cipher.updateAAD(aad);clear=cipher.doFinal(encoded,17,encoded.length-17);active();if(clear.length<1||clear.length>NativeMeshIdentityStore.MAX_BYTES)throw new Exception();byte[] result=clear;clear=null;return result;
      }catch(Exception failure){failed=true;throw new NativeMeshIdentityStore.Failure();}finally{wipe(encoded);wipe(clear);}}
    public synchronized void write(byte[] clear,boolean initialize){byte[] encrypted=null,encoded=null,readback=null;boolean replaced=false;try{active();if(clear==null||clear.length<1||clear.length>NativeMeshIdentityStore.MAX_BYTES||temporary.exists()||initialize==file.exists()||initialize&&keys.exists())throw new Exception();
      Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,keys.key(initialize));cipher.updateAAD(aad);byte[] iv=cipher.getIV();if(iv.length!=12)throw new Exception();encrypted=cipher.doFinal(clear);encoded=new byte[17+encrypted.length];System.arraycopy(HEADER,0,encoded,0,5);System.arraycopy(iv,0,encoded,5,12);System.arraycopy(encrypted,0,encoded,17,encrypted.length);active();
      if(!temporary.createNewFile())throw new Exception();try(FileOutputStream stream=new FileOutputStream(temporary)){stream.write(encoded);durability.syncFile(stream);}active();durability.replace(temporary,file);replaced=true;durability.syncDirectory(directory);durability.syncDirectory(directory.getParentFile());readback=read();if(!Arrays.equals(clear,readback))throw new Exception();active();
      }catch(Exception failure){failed=true;if(!replaced&&temporary.exists()&&!temporary.delete()){/* Residue is fail closed on next open. */}throw new NativeMeshIdentityStore.Failure();}finally{wipe(encrypted);wipe(encoded);wipe(readback);}}
  }
  private static void wipe(byte[] value){if(value!=null)Arrays.fill(value,(byte)0);}
  private static String hex(byte[] value){StringBuilder out=new StringBuilder();for(byte b:value){int n=b&255;out.append("0123456789abcdef".charAt(n>>>4)).append("0123456789abcdef".charAt(n&15));}return out.toString();}
}
