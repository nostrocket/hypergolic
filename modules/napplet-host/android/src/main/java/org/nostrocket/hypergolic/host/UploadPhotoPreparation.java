package org.nostrocket.hypergolic.host;

import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Set;

/** Lossless PNG from complete decoded pixels, with only canonical rendering profiles. */
final class UploadPhotoPreparation {
  private UploadPhotoPreparation() {}
  static UploadFileProfile.Prepared prepare(byte[] input) {
    UploadFileProfile.Prepared existing=UploadFileProfile.prepare(input);
    if (existing != null && existing.metadataPolicy().equals("attachment-unchanged")) return existing;
    String type=UploadPhotoContainer.type(input);
    if (type == null || !UploadPhotoContainer.validate(input,type)) return null;
    if (existing != null) return existing;
    if (Build.VERSION.SDK_INT < 28) return null;
    int orientation=type.equals("image/png") ? UploadPhotoContainer.pngOrientation(input) : 1;
    byte[] decode=type.equals("image/png") ? UploadPhotoContainer.pngWithoutExif(input) : input;
    if (orientation == 0 || decode == null) return null;
    Bitmap pixels=null;
    try {
      pixels=ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(decode)),(decoder,info,source) -> {
        int width=info.getSize().getWidth(),height=info.getSize().getHeight(); ColorSpace color=info.getColorSpace();
        if (width < 1 || height < 1 || width > 4096 || height > 4096 || (long)width*height > 4_194_304 || info.isAnimated() ||
          !Set.of("image/jpeg","image/png","image/webp","image/gif","image/heif","image/heic").contains(info.getMimeType()) ||
          color == null || !(color.equals(ColorSpace.get(ColorSpace.Named.SRGB)) || color.equals(ColorSpace.get(ColorSpace.Named.DISPLAY_P3)))) throw new IllegalArgumentException();
        decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE); decoder.setTargetColorSpace(color);
        decoder.setOnPartialImageListener(error -> false);
      });
      if (Build.VERSION.SDK_INT >= 34 && pixels.hasGainmap()) return null;
      if (orientation != 1) {
        float[][] values={null,null,{-1,0,0,0,1,0,0,0,1},{-1,0,0,0,-1,0,0,0,1},{1,0,0,0,-1,0,0,0,1},
          {0,1,0,1,0,0,0,0,1},{0,-1,0,1,0,0,0,0,1},{0,-1,0,-1,0,0,0,0,1},{0,1,0,-1,0,0,0,0,1}};
        var matrix=new Matrix();matrix.setValues(values[orientation]);
        Bitmap oriented=Bitmap.createBitmap(pixels,0,0,pixels.getWidth(),pixels.getHeight(),matrix,false);
        if (oriented != pixels) pixels.recycle();pixels=oriented;
      }
      ColorSpace color=pixels.getColorSpace();
      if (color == null || !(color.equals(ColorSpace.get(ColorSpace.Named.SRGB)) || color.equals(ColorSpace.get(ColorSpace.Named.DISPLAY_P3))) ||
        pixels.getWidth() > 4096 || pixels.getHeight() > 4096 || (long)pixels.getWidth()*pixels.getHeight() > 4_194_304) return null;
      var output=new BoundedOutput();
      if (!pixels.compress(Bitmap.CompressFormat.PNG,100,output) || output.size() > NativeUploadAuthority.MAX_BYTES) return null;
      byte[] safe=output.toByteArray();
      if (!UploadPhotoContainer.validate(safe,"image/png")) return null;
      return new UploadFileProfile.Prepared(safe,"image/png","photo-stripped");
    } catch (Exception invalid) {return null;}
    finally {if (pixels != null) pixels.recycle();}
  }
  private static final class BoundedOutput extends ByteArrayOutputStream {
    @Override public synchronized void write(int value) {if (count >= NativeUploadAuthority.MAX_BYTES) throw new IllegalArgumentException(); super.write(value);}
    @Override public synchronized void write(byte[] bytes,int offset,int length) {
      if (length > NativeUploadAuthority.MAX_BYTES-count) throw new IllegalArgumentException(); super.write(bytes,offset,length);
    }
  }
}
