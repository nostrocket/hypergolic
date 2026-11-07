package org.nostrocket.hypergolic.host;

import java.io.IOException;

/** Frame-bounded Layer III input. Strip only a bounded initial ID3 prefix; reject later junk/format changes. */
final class LiveMP3Gate implements LiveMP3Response.Sink {
  private static final int MAX_ID3 = 64 * 1024;
  private static final int[] V1 = {0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0};
  private static final int[] V2 = {0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0};
  private static final int[] RATES = {44100,48000,32000};
  private final LiveMP3Response.Sink output;
  private final byte[] header = new byte[10], frame = new byte[2048];
  private int have, skip, metadata, frameSize, frameHave, format;
  private long frames;
  LiveMP3Gate(LiveMP3Response.Sink output) { this.output = output; }
  @Override public void append(byte[] bytes, int count) throws IOException {
    if (count < 0 || count > bytes.length || count > 8192) throw new IOException("Invalid MP3 chunk");
    int index = 0;
    while (index < count) {
      if (skip > 0) { int size = Math.min(skip, count - index); skip -= size; index += size; continue; }
      if (frameSize > 0) {
        int size = Math.min(frameSize - frameHave, count - index);
        System.arraycopy(bytes, index, frame, frameHave, size); index += size; frameHave += size;
        if (frameHave == frameSize) { output.append(frame, frameSize); frames++; frameSize = 0; frameHave = 0; }
        continue;
      }
      header[have++] = bytes[index++];
      if (have == 3 && header[0] == 'I' && header[1] == 'D' && header[2] == '3') {
        if (frames != 0) throw new IOException("Midstream metadata is unsupported");
      } else if (have == 4 && header[0] != 'I') {
        frameSize = frameLength(); System.arraycopy(header, 0, frame, 0, 4); frameHave = 4; have = 0;
      } else if (have == 10) { id3(); }
    }
  }
  private void id3() throws IOException {
    if (header[0] != 'I' || header[1] != 'D' || header[2] != '3' || frames != 0 ||
        header[3] < 2 || header[3] > 4 || header[4] == (byte)255 || (header[5] & 31) != 0) throw new IOException("Unsupported ID3 header");
    int size = 0;
    for (int i = 6; i < 10; i++) { if (header[i] < 0) throw new IOException("Invalid ID3 size"); size = (size << 7) | header[i]; }
    if (size > MAX_ID3 - metadata - 10) throw new IOException("ID3 prefix limit");
    metadata += size + 10; skip = size; have = 0;
  }
  private int frameLength() throws IOException {
    int first = header[0] & 255, second = header[1] & 255, third = header[2] & 255;
    int version = (second >> 3) & 3, rate = (third >> 2) & 3, bitrate = (third >> 4) & 15;
    if (first != 255 || (second & 224) != 224 || version == 1 || (second & 6) != 2 || rate == 3 ||
        bitrate == 0 || bitrate == 15 || (header[3] & 3) == 2) throw new IOException("Unsupported MP3 frame");
    int signature = (version << 8) | (rate << 4) | (((header[3] & 192) == 192) ? 1 : 2);
    if (format != 0 && signature != format) throw new IOException("Live MP3 format changed");
    format = signature;
    int sampleRate = RATES[rate] / (version == 3 ? 1 : version == 2 ? 2 : 4);
    int length = (version == 3 ? 144000 * V1[bitrate] : 72000 * V2[bitrate]) / sampleRate + ((third >> 1) & 1);
    if (length < 4 || length > frame.length) throw new IOException("MP3 frame size limit");
    return length;
  }
  void finish() throws IOException {
    if (frames == 0 || have != 0 || skip != 0 || frameSize != 0) throw new IOException("Truncated MP3 frame or prefix");
  }
}
