package org.nostrocket.hypergolic.signercore;

import android.content.Intent;
import android.net.Uri;
import android.os.Parcel;

/** Conservative single-Intent profile; Binder's process-shared limit is larger but not available to reserve. */
final class NativeAndroidSignerParcel {
  static final int MAX_BYTES = 512 * 1024;
  private NativeAndroidSignerParcel() {}
  static void bounded(Intent value,String errorCode) {
    if(value==null) throw new NativeVault.Error(errorCode);
    Parcel parcel=Parcel.obtain();
    try {
      value.writeToParcel(parcel,0);
      if(parcel.hasFileDescriptors() || parcel.dataSize()>MAX_BYTES) throw new NativeVault.Error(errorCode);
    } catch(NativeVault.Error failure) { throw failure; }
    catch(Exception failure) { throw new NativeVault.Error(errorCode); }
    finally { parcel.recycle(); }
  }
  static Intent publicKey(NativeAndroidSignerBinding selected,String requestId) {
    Intent value=new Intent(Intent.ACTION_VIEW,Uri.parse("nostrsigner:"))
      .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(selected.packageName)
      .putExtra("type","get_public_key").putExtra("id",requestId);
    bounded(value,"SIGNER_UNSUPPORTED");
    return value;
  }
  static Intent sign(NativeAndroidSignerBinding selected,String requestId,NativeEvent event) {
    Intent value=new Intent(Intent.ACTION_VIEW,Uri.fromParts("nostrsigner",event.unsigned,null))
      .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(selected.packageName)
      .putExtra("type","sign_event").putExtra("id",requestId).putExtra("current_user",event.pubkey);
    bounded(value,"SIGNER_UNSUPPORTED");
    return value;
  }
}
