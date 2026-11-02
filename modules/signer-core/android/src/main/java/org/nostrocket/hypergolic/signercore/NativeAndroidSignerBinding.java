package org.nostrocket.hypergolic.signercore;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Selected installed Android app identity. Display labels and returned package strings are not authority. */
final class NativeAndroidSignerBinding {
  final String packageName;
  final List<String> certificateSha256s;
  NativeAndroidSignerBinding(String packageName, List<String> certificates) {
    if(packageName==null || packageName.length()>255 ||
        !packageName.matches("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+")) {
      throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    }
    if(certificates==null || certificates.isEmpty() || certificates.size()>16) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    List<String> copy=new ArrayList<>(certificates);
    String previous=null;
    for(String certificate:copy) {
      if(certificate==null || !certificate.matches("[0-9a-f]{64}") || previous!=null && previous.compareTo(certificate)>=0) {
        throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
      }
      previous=certificate;
    }
    this.packageName=packageName; certificateSha256s=Collections.unmodifiableList(copy);
  }
  boolean sameInstallation(NativeAndroidSignerBinding other) {
    return other!=null && packageName.equals(other.packageName) && certificateSha256s.equals(other.certificateSha256s);
  }
}
