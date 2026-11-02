package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/** Actual Android Parcel/URI and native signature validators; no external Activity/result-ownership claim. */
public final class NativeAndroidSignerModelProof {
  private static int assertions;
  static int completedAssertions() { return assertions; }
  private static JSONObject publicTrace;
  static JSONObject trace() throws Exception { return new JSONObject(publicTrace.toString()); }
  private static int parcelBytes(Intent value) {
    android.os.Parcel parcel=android.os.Parcel.obtain();
    try { value.writeToParcel(parcel,0);return parcel.dataSize(); }
    finally { parcel.recycle(); }
  }
  private static void check(boolean value) { assertions++;if(!value)throw new AssertionError("Android signer model assertion "+assertions); }
  private static void denied(String code,Runnable effect) {
    try { effect.run();throw new AssertionError("Expected denial"); }
    catch(NativeVault.Error failure) { check(code.equals(failure.code)); }
  }
  private static Intent lookup(String id,String pubkey,String name) {
    return new Intent().putExtra("id",id).putExtra("result",pubkey).putExtra("package",name);
  }
  private static Intent signed(String id,String signature,String event) {
    return new Intent().putExtra("id",id).putExtra("result",signature).putExtra("event",event);
  }
  private static NativeEvent event(String pubkey,String content) throws Exception {
    return NativeEvent.capture(new JSONObject().put("pubkey",pubkey).put("kind",1).put("created_at",1)
      .put("tags",new org.json.JSONArray()).put("content",content).toString(),pubkey);
  }
  public static int run(Context context) throws Exception {
    assertions=0;publicTrace=null;
    String name="org.example.signer", request="native-signer-model-request";
    ArrayList<String> certificates=new ArrayList<>(List.of("01".repeat(32),"02".repeat(32)));
    NativeAndroidSignerBinding selected=new NativeAndroidSignerBinding(name,certificates);
    certificates.clear();check(selected.certificateSha256s.size()==2);
    check(selected.sameInstallation(new NativeAndroidSignerBinding(name,selected.certificateSha256s)));
    check(!selected.sameInstallation(new NativeAndroidSignerBinding(name,List.of("03".repeat(32)))));
    denied("SIGNER_RESPONSE_INVALID",()->new NativeAndroidSignerBinding("org._bad",List.of("01".repeat(32))));
    denied("SIGNER_RESPONSE_INVALID",()->new NativeAndroidSignerBinding(name,List.of("01".repeat(32),"01".repeat(32))));
    denied("SIGNER_RESPONSE_INVALID",()->new NativeAndroidSignerBinding(name,List.of("02".repeat(32),"01".repeat(32))));
    denied("SIGNER_RESPONSE_INVALID",()->new NativeAndroidSignerBinding(name,List.of("FF".repeat(32))));
    denied("SIGNER_RESPONSE_INVALID",()->new NativeAndroidSignerBinding(name,List.of()));
    ArrayList<String> tooMany=new ArrayList<>();for(int i=0;i<17;i++)tooMany.add(String.format(java.util.Locale.ROOT,"%064x",i));
    denied("SIGNER_RESPONSE_INVALID",()->new NativeAndroidSignerBinding(name,tooMany));
    try(NativeSigningKey key=new NativeSigningKey()) {
      String pubkey=key.publicKey();
      Intent lookup=NativeAndroidSignerParcel.publicKey(selected,request);
      check(name.equals(lookup.getPackage()));check(request.equals(lookup.getStringExtra("id")));
      check("get_public_key".equals(lookup.getStringExtra("type")));check(lookup.getFlags()==0);
      check(pubkey.equals(NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name),Activity.RESULT_OK,request,selected)));
      // Amber 6.6.6 returns these redundant String extras for a public-key Activity result.
      check(pubkey.equals(NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).putExtra("signature",pubkey).putExtra("event",pubkey),Activity.RESULT_OK,request,selected)));
      for(String field:List.of("signature","event")) {
        check(pubkey.equals(NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).putExtra(field,pubkey),Activity.RESULT_OK,request,selected)));
        denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).putExtra(field,"ff".repeat(32)),Activity.RESULT_OK,request,selected));
        denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).putExtra(field,17),Activity.RESULT_OK,request,selected));
        denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).putExtra(field,(String)null),Activity.RESULT_OK,request,selected));
      }
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup("wrong",pubkey,name),Activity.RESULT_OK,request,selected));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,pubkey,"org.example.other"),Activity.RESULT_OK,request,selected));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,"00".repeat(32),name),Activity.RESULT_OK,request,selected));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).putExtra("unknown","value"),Activity.RESULT_OK,request,selected));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).putExtra("id",17),Activity.RESULT_OK,request,selected));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).putExtra("rejected","true"),Activity.RESULT_OK,request,selected));
      denied("SIGNER_REJECTED",()->NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).putExtra("rejected",true),Activity.RESULT_OK,request,selected));
      denied("SIGNER_APP_FAILED",()->NativeAndroidSignerResult.publicKey(null,Activity.RESULT_CANCELED,request,selected));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(null,Activity.RESULT_OK,request,selected));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,pubkey,name).setData(android.net.Uri.parse("content://unexpected")),Activity.RESULT_OK,request,selected));
      Intent clipped=lookup(request,pubkey,name);clipped.setClipData(android.content.ClipData.newPlainText("public fixture","unexpected"));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(clipped,Activity.RESULT_OK,request,selected));
      NativeEvent event=event(pubkey,"Reserved # / ? % literal%25 Unicode \uD83D\uDE00 e\u0301");
      Intent outbound=NativeAndroidSignerParcel.sign(selected,request,event);
      check(event.unsigned.equals(outbound.getData().getSchemeSpecificPart()));
      check(outbound.getDataString().contains("%23"));check(outbound.getDataString().contains("%25"));
      check(pubkey.equals(outbound.getStringExtra("current_user")));check(request.equals(outbound.getStringExtra("id")));
      String signature=key.sign(event.digest), exact=event.signed(signature);
      check(exact.equals(NativeAndroidSignerResult.signedEvent(signed(request,signature,exact),Activity.RESULT_OK,request,event)));
      check(exact.equals(NativeAndroidSignerResult.signedEvent(signed(request,signature,exact).putExtra("signature",signature),Activity.RESULT_OK,request,event)));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed(request,signature,exact).putExtra("signature","ff".repeat(64)),Activity.RESULT_OK,request,event));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed(request,signature,exact).putExtra("signature",17),Activity.RESULT_OK,request,event));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed(request,signature,exact).putExtra("signature",(String)null),Activity.RESULT_OK,request,event));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed(request,signature,exact).putExtra("unknown",signature),Activity.RESULT_OK,request,event));
      publicTrace=new JSONObject().put("unsignedEvent",new JSONObject(event.unsigned)).put("signedEvent",new JSONObject(exact));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(null,Activity.RESULT_OK,request,event));
      try(NativeSigningKey other=new NativeSigningKey()) {
        NativeEvent foreign=event(other.publicKey(),event.content);String foreignSignature=other.sign(foreign.digest),foreignEvent=foreign.signed(foreignSignature);
        denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed(request,foreignSignature,foreignEvent),Activity.RESULT_OK,request,event));
      }
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed("wrong",signature,exact),Activity.RESULT_OK,request,event));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed(request,"ff".repeat(64),exact),Activity.RESULT_OK,request,event));
      NativeEvent changed=event(pubkey,event.content+"changed");String changedEvent=changed.signed(key.sign(changed.digest));
      String changedSignature=new JSONObject(changedEvent).getString("sig");
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed(request,changedSignature,changedEvent),Activity.RESULT_OK,request,event));
      JSONObject wrongHash=new JSONObject(exact).put("id","00".repeat(32));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed(request,signature,wrongHash.toString()),Activity.RESULT_OK,request,event));
      JSONObject wrongSignature=new JSONObject(exact).put("sig","ff".repeat(64));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.signedEvent(signed(request,"ff".repeat(64),wrongSignature.toString()),Activity.RESULT_OK,request,event));
      JSONObject sizes=new JSONObject().put("cap",NativeAndroidSignerParcel.MAX_BYTES).put("acceptedParcel",parcelBytes(outbound));
      publicTrace.put("parcelMeasurements",sizes);
      check(parcelBytes(outbound)<=NativeAndroidSignerParcel.MAX_BYTES);
      NativeEvent oversized=event(pubkey,"x".repeat(600000));
      Intent oversizedProbe=NativeAndroidSignerParcel.publicKey(selected,request);
      oversizedProbe.setData(android.net.Uri.fromParts("nostrsigner",oversized.unsigned,null));
      sizes.put("asciiOversizeParcel",parcelBytes(oversizedProbe));
      check(parcelBytes(oversizedProbe)>NativeAndroidSignerParcel.MAX_BYTES);
      denied("SIGNER_UNSUPPORTED",()->NativeAndroidSignerParcel.sign(selected,request,oversized));
      NativeEvent expanded=event(pubkey,"\uD83D\uDE00".repeat(50000));
      sizes.put("emojiRawUtf8",expanded.unsigned.getBytes(StandardCharsets.UTF_8).length);
      check(expanded.unsigned.getBytes(StandardCharsets.UTF_8).length<NativeAndroidSignerParcel.MAX_BYTES);
      Intent expandedRepresentation=NativeAndroidSignerParcel.publicKey(selected,request);
      expandedRepresentation.setData(android.net.Uri.fromParts("nostrsigner",expanded.unsigned,null));
      check(expanded.unsigned.equals(expandedRepresentation.getData().getSchemeSpecificPart()));
      sizes.put("emojiEncodedUtf8",expandedRepresentation.getDataString().getBytes(StandardCharsets.UTF_8).length);
      sizes.put("emojiOpaqueParcel",parcelBytes(expandedRepresentation));
      check(expandedRepresentation.getDataString().getBytes(StandardCharsets.UTF_8).length>NativeAndroidSignerParcel.MAX_BYTES);
      check(parcelBytes(expandedRepresentation)>NativeAndroidSignerParcel.MAX_BYTES);
      denied("SIGNER_UNSUPPORTED",()->NativeAndroidSignerParcel.sign(selected,request,expanded));
      denied("SIGNER_UNSUPPORTED",()->NativeAndroidSignerParcel.bounded(expandedRepresentation,"SIGNER_UNSUPPORTED"));
      expandedRepresentation.setData(android.net.Uri.parse(expandedRepresentation.getDataString()));
      sizes.put("emojiStringParcel",parcelBytes(expandedRepresentation));
      check(expanded.unsigned.equals(expandedRepresentation.getData().getSchemeSpecificPart()));
      check(parcelBytes(expandedRepresentation)>NativeAndroidSignerParcel.MAX_BYTES);
      denied("SIGNER_UNSUPPORTED",()->NativeAndroidSignerParcel.bounded(expandedRepresentation,"SIGNER_UNSUPPORTED"));
      denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerResult.publicKey(lookup(request,"x".repeat(300000),name),Activity.RESULT_OK,request,selected));
    }
    File descriptorFile=new File(context.getCacheDir(),"public-signer-parcel-proof");
    try {
      try(var output=new java.io.FileOutputStream(descriptorFile)){output.write(1);}
      try(ParcelFileDescriptor descriptor=ParcelFileDescriptor.open(descriptorFile,ParcelFileDescriptor.MODE_READ_ONLY)) {
        Intent value=new Intent().putExtra("descriptor",descriptor);
        denied("SIGNER_RESPONSE_INVALID",()->NativeAndroidSignerParcel.bounded(value,"SIGNER_RESPONSE_INVALID"));
      }
    } finally { check(descriptorFile.delete()); }
    return assertions;
  }
}
