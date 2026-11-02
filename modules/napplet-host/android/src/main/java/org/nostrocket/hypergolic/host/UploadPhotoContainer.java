package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Set;
import java.util.zip.CRC32;

/** Reject malformed metadata before codecs can silently ignore it. */
final class UploadPhotoContainer {
  private UploadPhotoContainer() {}
  static String type(byte[] b) {
    if (b == null || b.length < 4 || b.length > NativeUploadAuthority.MAX_BYTES) return null;
    if ((b[0] & 255) == 255 && (b[1] & 255) == 216) return "image/jpeg";
    if (b.length >= 8 && Arrays.equals(Arrays.copyOf(b, 8),new byte[]{(byte)137,80,78,71,13,10,26,10})) return "image/png";
    if (b.length >= 6 && Set.of("GIF87a","GIF89a").contains(text(b,0,6))) return "image/gif";
    if (b.length >= 12 && text(b,0,4).equals("RIFF") && text(b,8,4).equals("WEBP")) return "image/webp";
    if (b.length >= 24 && text(b,4,4).equals("ftyp") && Set.of("heic","heix","hevc","hevx","mif1","msf1").contains(text(b,8,4))) return "image/heif";
    return null;
  }
  static boolean validate(byte[] b, String type) {
    if (b == null || type == null) return false;
    return switch (type) {
      case "image/jpeg" -> jpeg(b); case "image/png" -> png(b); case "image/webp" -> webp(b); case "image/heif" -> heic(b);
      case "image/gif" -> b.length >= 14 && Set.of("GIF87a","GIF89a").contains(text(b,0,6)) && b[b.length-1] == 59;
      default -> false;
    };
  }
  static int pngOrientation(byte[] b) {
    if (!validate(b,"image/png")) return 0;
    for (int at=8;at<=b.length-12;) {
      int size=(int)number(b,at,false);
      if (text(b,at+4,4).equals("eXIf")) return UploadExifMetadata.orientation(b,at+8,size);
      at+=size+12;
    }
    return 1;
  }
  static byte[] pngWithoutExif(byte[] b) {
    if (!validate(b,"image/png")) return null;
    var out=new java.io.ByteArrayOutputStream();out.write(b,0,8);
    for (int at=8;at<=b.length-12;) {
      int size=(int)number(b,at,false);
      if (!text(b,at+4,4).equals("eXIf")) out.write(b,at,size+12);
      at+=size+12;
    }
    return out.toByteArray();
  }
  private static boolean jpeg(byte[] b) {
    if (b.length < 4 || (b[0]&255) != 255 || (b[1]&255) != 216 || (b[b.length-2]&255) != 255 || (b[b.length-1]&255) != 217) return false;
    int at=2,count=0; boolean exif=false;
    while (at < b.length-2) {
      if ((b[at]&255) != 255) return false; at++;
      while (at < b.length && (b[at]&255) == 255) at++;
      if (at >= b.length) return false; int tag=b[at++]&255;
      if (tag == 0 || tag == 216 || tag == 217 || (tag >= 208 && tag <= 215) || at > b.length-2) return false;
      int size=(b[at]&255)<<8 | (b[at+1]&255);
      if (size < 2 || size > b.length-at || ++count > 4096) return false;
      if (tag == 225 && size >= 8 && text(b,at+2,6).equals("Exif\0\0")) {
        if (exif || UploadExifMetadata.orientation(b,at+8,size-8) == 0) return false; exif=true;
      }
      if (tag == 218) return true; at += size;
    }
    return false;
  }
  private static boolean png(byte[] b) {
    if (b.length < 57 || !"image/png".equals(type(b))) return false;
    Set<String> allowed=Set.of("IHDR","PLTE","tRNS","IDAT","IEND","cHRM","gAMA","iCCP","sRGB","cICP","sBIT","bKGD","pHYs","tEXt","zTXt","iTXt","tIME","eXIf");
    int at=8,count=0; boolean exif=false,pixels=false,endedPixels=false,header=false;
    var seen=new java.util.HashSet<String>();
    while (at <= b.length-12) {
      long raw=number(b,at,false); if (raw > b.length-at-12) return false; int size=(int)raw;
      String tag=text(b,at+4,4); if (!allowed.contains(tag) || ++count > 4096 || (at == 8 && !tag.equals("IHDR"))) return false;
      if (tag.equals("IHDR")) {if (header || size != 13) return false; header=true;}
      if (!Set.of("IDAT","tEXt","zTXt","iTXt").contains(tag) && !seen.add(tag)) return false;
      if (tag.equals("PLTE") && (pixels || size < 3 || size > 768 || size%3 != 0)) return false;
      if (Set.of("gAMA","cHRM","iCCP","sRGB","sBIT","cICP").contains(tag) && pixels) return false;
      if (seen.contains("iCCP") && seen.contains("sRGB")) return false;
      var crc=new CRC32(); crc.update(b,at+4,size+4); if (crc.getValue() != number(b,at+8+size,false)) return false;
      if (tag.equals("eXIf")) {if (exif || UploadExifMetadata.orientation(b,at+8,size) == 0) return false; exif=true;}
      if (tag.equals("IDAT")) {if (endedPixels) return false; pixels=true;} else if (pixels) endedPixels=true;
      at += size+12; if (tag.equals("IEND")) return pixels && size == 0 && at == b.length;
    }
    return false;
  }
  private static boolean webp(byte[] b) {
    if (b.length < 20 || !text(b,0,4).equals("RIFF") || !text(b,8,4).equals("WEBP") || number(b,4,true) != b.length-8) return false;
    int at=12,count=0; boolean exif=false,pixels=false;
    while (at <= b.length-8) {
      long raw=number(b,at+4,true); String tag=text(b,at,4);
      if (raw > b.length-at-8 || ++count > 4096 || !Set.of("VP8 ","VP8L","VP8X","ALPH","ICCP","EXIF","XMP ").contains(tag)) return false;
      int size=(int)raw;
      if (tag.equals("EXIF")) {
        int prefix=size >= 6 && text(b,at+8,6).equals("Exif\0\0") ? 6 : 0;
        if (exif || UploadExifMetadata.orientation(b,at+8+prefix,size-prefix) == 0) return false; exif=true;
      }
      if (tag.equals("VP8 ") || tag.equals("VP8L")) {if (pixels) return false; pixels=true;}
      at += size+8+(size&1);
    }
    return at == b.length && pixels;
  }
  private static boolean heic(byte[] b) {
    if (b.length < 24 || !text(b,4,4).equals("ftyp")) return false;
    int at=0,count=0; boolean metadata=false,pixels=false;
    while (at <= b.length-8) {
      long size=number(b,at,false); int header=8; String tag=text(b,at+4,4);
      if (size == 1) {if (at > b.length-16 || number(b,at+8,false) != 0) return false; size=number(b,at+12,false); header=16;}
      if (size == 0) size=b.length-at;
      if (size < header || size > b.length-at || ++count > 4096) return false;
      metadata |= tag.equals("meta"); pixels |= tag.equals("mdat"); at += (int)size;
    }
    return at == b.length && metadata && pixels;
  }
  private static String text(byte[] b,int at,int count) {return new String(b,at,count,StandardCharsets.ISO_8859_1);}
  private static long number(byte[] b,int at,boolean little) {long value=0; for(int i=0;i<4;i++) value=value<<8 | (b[at+(little?3-i:i)]&255L); return value;}
}
