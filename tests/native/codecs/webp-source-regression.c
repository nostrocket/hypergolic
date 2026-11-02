#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "src/utils/huffman_utils.h"
#include "src/webp/decode.h"
#include "src/webp/encode.h"

int main(void) {
  assert(WebPGetDecoderVersion() == 0x010600);
  assert(WebPGetEncoderVersion() == 0x010600);
  int lengths[256];
  for (int i = 0; i < 256; ++i) lengths[i] = 8;
  for (int initial = 1; initial <= 128; initial *= 2) {
    HuffmanTables tables;
    memset(&tables, 0, sizeof(tables));
    assert(VP8LHuffmanTablesAllocate(initial, &tables));
    HuffmanTablesSegment* first = tables.curr_segment;
    assert(VP8LBuildHuffmanTable(NULL, 8, lengths, 256) == 256);
    assert(VP8LBuildHuffmanTable(&tables, 8, lengths, 256) == 256);
    assert(tables.curr_segment != first);
    assert(tables.curr_segment->size >= 256);
    for (int i = 0; i < 256; ++i) {
      assert(tables.curr_segment->curr_table[i].bits == 8);
      assert(tables.curr_segment->curr_table[i].value < 256);
    }
    VP8LHuffmanTablesDeallocate(&tables);
  }
  uint8_t pixels[31 * 19 * 4];
  for (int i = 0; i < 31 * 19; ++i) {
    pixels[i * 4] = (uint8_t)(i * 7);
    pixels[i * 4 + 1] = (uint8_t)(i * 13);
    pixels[i * 4 + 2] = (uint8_t)(i * 23);
    pixels[i * 4 + 3] = 255;
  }
  uint8_t* encoded = NULL;
  size_t size = WebPEncodeLosslessRGBA(pixels, 31, 19, 31 * 4, &encoded);
  assert(size > 12 && encoded != NULL);
  int width = 0, height = 0;
  uint8_t* decoded = WebPDecodeRGBA(encoded, size, &width, &height);
  assert(decoded != NULL && width == 31 && height == 19);
  assert(memcmp(decoded, pixels, sizeof(pixels)) == 0);
  WebPFree(decoded);
  for (size_t n = 0; n < 12; ++n) {
    decoded = WebPDecodeRGBA(encoded, n, &width, &height);
    assert(decoded == NULL);
  }
  WebPFree(encoded);
  puts("PASS: 8 undersized-table growth cases, exact lossless RGBA round-trip, 12 short-header rejections; libwebp1.6.0 ASan/UBSan host source build.");
  return 0;
}
