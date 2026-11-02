package org.nostrocket.hypergolic.host;

import org.json.JSONObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

/** Actual Android ImageDecoder/PNG codec probe; shell UID, separate from picker acceptance. */
public final class UploadPhotoDeviceProof {
  private UploadPhotoDeviceProof() {}
  public static void main(String[] args) throws Exception {
    Path root=Path.of(args[0]),out=Path.of(args[1]);Files.createDirectories(out);
    var manifest=new JSONObject(new String(Files.readAllBytes(root.resolve("photos.json")),java.nio.charset.StandardCharsets.UTF_8)); int checks=0;
    var files=manifest.getJSONArray("files");
    for (int i=0;i<files.length();i++) {
      String name=files.getJSONObject(i).getString("file");byte[] input=Files.readAllBytes(root.resolve(name));
      System.out.println("PREPARE:"+name); System.out.flush();
      var prepared=UploadPhotoPreparation.prepare(input);
      if (prepared == null) {
        String type=UploadPhotoContainer.type(input);System.out.println("DIAGNOSTIC:type="+type+";container="+UploadPhotoContainer.validate(input,type));
        try {var bitmap=android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(java.nio.ByteBuffer.wrap(input)),(decoder,info,source)->{System.out.println("HEADER:"+info.getMimeType()+";"+info.getSize()+";"+info.getColorSpace()+";animated="+info.isAnimated());decoder.setAllocator(android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE);});System.out.println("DECODED:"+bitmap.getWidth()+"x"+bitmap.getHeight()+";"+bitmap.getColorSpace());bitmap.recycle();} catch (Exception error) {error.printStackTrace(System.out);} System.out.flush();
      }
      if (prepared == null || !prepared.mimeType().equals("image/png") || !prepared.metadataPolicy().equals("photo-stripped")) throw new AssertionError("Valid photo denied: "+name);
      checks++;
      var repeated=UploadPhotoPreparation.prepare(prepared.bytes());
      if (repeated == null || !Arrays.equals(prepared.bytes(),repeated.bytes())) throw new AssertionError("Not idempotent: "+name);
      checks++;Files.write(out.resolve(name+".png"),prepared.bytes());
      var visible=android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(java.nio.ByteBuffer.wrap(input)),(decoder,info,source)->{decoder.setAllocator(android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE);decoder.setTargetColorSpace(info.getColorSpace());decoder.setOnPartialImageListener(error->false);});
      try(var stream=Files.newOutputStream(out.resolve(name+".source.png"))) {if (!visible.compress(android.graphics.Bitmap.CompressFormat.PNG,100,stream)) throw new AssertionError("Source decode reference failed");} finally {visible.recycle();}
    }
    var invalid=manifest.getJSONArray("invalid");
    for (int i=0;i<invalid.length();i++) {
      String name=invalid.getJSONObject(i).getString("file");
      if (UploadPhotoPreparation.prepare(Files.readAllBytes(root.resolve(name))) != null) throw new AssertionError("Invalid photo admitted: "+name);checks++;
    }
    System.out.println("UploadPhotoDeviceProof: "+checks+" checks passed");
  }
}
