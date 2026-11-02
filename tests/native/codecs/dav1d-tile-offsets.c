#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include "config.h"
#include "src/internal.h"

static void offsets(const Dav1dContext *c, Dav1dFrameContext *f) {
/* HYPERGOLIC_OWNING_TILE_LOOP */
}

static void check(int step, int width, int split, const uint32_t expected[4]) {
    Dav1dContext *c = calloc(1, sizeof(*c));
    Dav1dFrameContext *f = calloc(1, sizeof(*f));
    Dav1dFrameHeader *h = calloc(1, sizeof(*h));
    assert(c && f && h);
    unsigned result[4] = {0};
    c->n_fc = 2;
    f->frame_hdr = h;
    f->sb_step = step;
    f->sb128w = width;
    f->frame_thread.tile_start_off = result;
    h->tiling.rows = h->tiling.cols = 2;
    h->tiling.row_start_sb[1] = h->tiling.col_start_sb[1] = split;
    h->tiling.row_start_sb[2] = h->tiling.col_start_sb[2] = split * 2;
    offsets(c, f);
    for (int i = 0; i < 4; i++) assert(result[i] == expected[i]);
    free(h);
    free(f);
    free(c);
}

int main(void) {
    const uint32_t small[4] = {0, 4096, 32768, 36864};
    const uint32_t large[4] = {0, 0x40000000u, 0x80000000u, 0xc0000000u};
    check(16, 4, 1, small);
    check(32, 512, 256, large);
    check(16, 512, 512, large);
    puts("PASS: actual decoder loop, 12 exact offsets including signed-boundary crossings; host ASan/UBSan arithmetic subset.");
}
