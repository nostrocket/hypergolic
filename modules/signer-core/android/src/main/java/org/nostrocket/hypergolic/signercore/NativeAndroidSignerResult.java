package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import java.nio.charset.StandardCharsets;
import java.util.Set;

/** Validates an OS-owned Activity result for one native request; returned package text is never caller proof. */
final class NativeAndroidSignerResult {
  static final int MAX_EVENT_BYTES = NativeAndroidSignerParcel.MAX_BYTES;
  private NativeAndroidSignerResult() {}
  private static Bundle result(Intent data,int resultCode,String requestId,Set<String> fields) {
    if(resultCode!=Activity.RESULT_OK) throw new NativeVault.Error("SIGNER_APP_FAILED");
    if(data==null || data.getData()!=null || data.getClipData()!=null) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    NativeAndroidSignerParcel.bounded(data,"SIGNER_RESPONSE_INVALID");
    data.setExtrasClassLoader(ClassLoader.getSystemClassLoader());
    Bundle values=data.getExtras();
    if(values==null || !fields.containsAll(values.keySet()) || !(values.get("id") instanceof String) || !requestId.equals(values.getString("id"))) {
      throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    }
    if(values.containsKey("rejected")) {
      if(!(values.get("rejected") instanceof Boolean)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
      if(values.getBoolean("rejected")) throw new NativeVault.Error("SIGNER_REJECTED");
    }
    return values;
  }
  static String publicKey(Intent data,int resultCode,String requestId,NativeAndroidSignerBinding selected) {
    try {
      Bundle values=result(data,resultCode,requestId,Set.of("id","result","package","rejected","signature","event"));
      if(!(values.get("package") instanceof String) || !selected.packageName.equals(values.getString("package")) ||
          !(values.get("result") instanceof String)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
      String pubkey=values.getString("result");
      if(!NativeSigningKey.validPublicKey(pubkey)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
      for(String field:Set.of("signature","event")) {
        if(values.containsKey(field) && (!(values.get(field) instanceof String) || !pubkey.equals(values.getString(field)))) {
          throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
        }
      }
      return pubkey;
    } catch(NativeVault.Error failure) { throw failure; }
    catch(Exception failure) { throw new NativeVault.Error("SIGNER_RESPONSE_INVALID"); }
  }
  static String signedEvent(Intent data,int resultCode,String requestId,NativeEvent expected) {
    try {
      Bundle values=result(data,resultCode,requestId,Set.of("id","result","event","rejected","signature"));
      if(!(values.get("result") instanceof String) || !(values.get("event") instanceof String)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
      String signature=values.getString("result"), raw=values.getString("event");
      if(!signature.matches("[0-9a-f]{128}") || raw.length()>MAX_EVENT_BYTES || raw.getBytes(StandardCharsets.UTF_8).length>MAX_EVENT_BYTES) {
        throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
      }
      if(values.containsKey("signature") && (!(values.get("signature") instanceof String) || !signature.equals(values.getString("signature")))) {
        throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
      }
      String exact=NativeSignedEvent.exact(raw,expected);
      if(!new org.json.JSONObject(exact).getString("sig").equals(signature)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
      return exact;
    } catch(NativeVault.Error failure) { throw failure; }
    catch(Exception failure) { throw new NativeVault.Error("SIGNER_RESPONSE_INVALID"); }
  }
}
