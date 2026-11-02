package org.nostrocket.hypergolic.signercore;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/** Native installed-package/certificate inspection only; no launch, callback, provider or JS-selected package. */
final class NativeAndroidSignerInventory {
  private NativeAndroidSignerInventory() {}
  private static Intent query() {
    return new Intent(Intent.ACTION_VIEW,Uri.parse("nostrsigner:")).addCategory(Intent.CATEGORY_BROWSABLE);
  }
  static List<NativeAndroidSignerBinding> installed(Context context) {
    if(Build.VERSION.SDK_INT<28) throw new NativeVault.Error("SIGNER_UNSUPPORTED");
    TreeSet<String> packages=new TreeSet<>();
    for(var activity:context.getPackageManager().queryIntentActivities(query(),0)) {
      if(activity.activityInfo!=null && activity.activityInfo.exported && activity.activityInfo.enabled) packages.add(activity.activityInfo.packageName);
    }
    if(packages.size()>64) throw new NativeVault.Error("LIMIT_REACHED");
    List<NativeAndroidSignerBinding> result=new ArrayList<>();
    for(String name:packages) result.add(read(context,name));
    return java.util.Collections.unmodifiableList(result);
  }
  static NativeAndroidSignerBinding read(Context context,String name) {
    if(Build.VERSION.SDK_INT<28) throw new NativeVault.Error("SIGNER_UNSUPPORTED");
    try {
      PackageManager packages=context.getPackageManager();
      PackageInfo info=packages.getPackageInfo(name,PackageManager.GET_SIGNING_CERTIFICATES);
      if(info.applicationInfo==null || !info.applicationInfo.enabled || info.signingInfo==null) throw new NativeVault.Error("SIGNER_UNAVAILABLE");
      Signature[] certificates=info.signingInfo.hasMultipleSigners() ? info.signingInfo.getApkContentsSigners() : info.signingInfo.getSigningCertificateHistory();
      if(certificates==null || certificates.length==0 || info.signingInfo.hasMultipleSigners() && certificates.length>16) throw new NativeVault.Error("SIGNER_IDENTITY_CHANGED");
      TreeSet<String> current=new TreeSet<>();
      int first=info.signingInfo.hasMultipleSigners() ? 0 : certificates.length-1;
      for(int index=first;index<certificates.length;index++) {
        byte[] bytes=certificates[index].toByteArray();
        try { current.add(NativeEvent.hex(MessageDigest.getInstance("SHA-256").digest(bytes))); }
        finally { java.util.Arrays.fill(bytes,(byte)0); }
      }
      boolean eligible=packages.queryIntentActivities(query().setPackage(name),0).stream()
        .anyMatch(value->value.activityInfo!=null && value.activityInfo.enabled && value.activityInfo.exported && name.equals(value.activityInfo.packageName));
      if(!eligible) throw new NativeVault.Error("SIGNER_UNAVAILABLE");
      return new NativeAndroidSignerBinding(name,new ArrayList<>(current));
    } catch(PackageManager.NameNotFoundException absent) { throw new NativeVault.Error("SIGNER_UNAVAILABLE"); }
    catch(NativeVault.Error failure) { throw failure; }
    catch(Exception failure) { throw new NativeVault.Error("SIGNER_IDENTITY_CHANGED"); }
  }
  static void requireCurrent(Context context,NativeAndroidSignerBinding expected) {
    if(!expected.sameInstallation(read(context,expected.packageName))) throw new NativeVault.Error("SIGNER_IDENTITY_CHANGED");
  }
}
