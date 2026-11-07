#include "hypergolic_mesh_frame.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned checks;
#define CHECK(x) do { ++checks; if (!(x)) { \
  fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #x); \
  exit(1); } } while (0)

typedef struct {
  const uint8_t *expected;
  size_t length;
  unsigned calls;
  int action;
  hg_mesh_frame_reader *reader;
} observation;

static int sink(void *context, uint8_t kind, const uint8_t *body, size_t count) {
  observation *o = context;
  CHECK(kind == HG_MESH_EVENT);
  CHECK(count == o->length);
  CHECK(memcmp(body, o->expected, count) == 0);
  ++o->calls;
  if (o->action == 1) return 0;
  if (o->action == 2) hg_mesh_frame_close(o->reader);
  if (o->action == 3) CHECK(!hg_mesh_frame_feed(o->reader, NULL, 0, sink, o));
  if (o->action == 4) CHECK(!hg_mesh_frame_eof(o->reader));
  /* Close during a callback must not alter the borrowed frame prematurely. */
  CHECK(memcmp(body, o->expected, count) == 0);
  return 1;
}

static void erased(const hg_mesh_frame_reader *r) {
  for (size_t i = 0; i < sizeof(r->header); ++i) CHECK(r->header[i] == 0);
  for (size_t i = 0; i < sizeof(r->payload); ++i) CHECK(r->payload[i] == 0);
  CHECK(r->header_used == 0 && r->payload_used == 0 && r->payload_length == 0);
}

static void fragments(void) {
  const uint8_t body[] = "{\"type\":\"event\",\"content\":\"hello\"}";
  uint8_t wire[256]; size_t count;
  CHECK(hg_mesh_frame_encode(HG_MESH_EVENT, body, sizeof(body)-1,
                              wire, sizeof(wire), &count));
  const uint8_t expected[] = {'H','G','M','1',1,16,0,0,0,0,0,34};
  CHECK(sizeof(body)-1 == 34);
  CHECK(memcmp(wire, expected, sizeof(expected)) == 0);
  for (size_t split = 0; split <= count; ++split) {
    hg_mesh_frame_reader r; hg_mesh_frame_init(&r);
    observation o = {body, sizeof(body)-1, 0, 0, &r};
    CHECK(hg_mesh_frame_feed(&r, wire, split, sink, &o));
    CHECK(o.calls == (split == count ? 1u : 0u));
    CHECK(hg_mesh_frame_feed(&r, wire+split, count-split, sink, &o));
    CHECK(o.calls == 1); erased(&r);
    CHECK(hg_mesh_frame_eof(&r));
    CHECK(!hg_mesh_frame_feed(&r, wire, count, sink, &o));
    CHECK(o.calls == 1);
  }
  hg_mesh_frame_reader r; hg_mesh_frame_init(&r);
  observation o = {body, sizeof(body)-1, 0, 0, &r};
  for (size_t i = 0; i < count; ++i)
    CHECK(hg_mesh_frame_feed(&r, wire+i, 1, sink, &o));
  CHECK(o.calls == 1 && hg_mesh_frame_eof(&r));
  for (size_t cut = 1; cut < count; ++cut) {
    hg_mesh_frame_init(&r); o.calls = 0;
    CHECK(hg_mesh_frame_feed(&r, wire, cut, sink, &o));
    CHECK(!hg_mesh_frame_eof(&r)); erased(&r);
    CHECK(!hg_mesh_frame_feed(&r, wire+cut, count-cut, sink, &o));
    CHECK(o.calls == 0);
  }
}

static void terminal(void) {
  uint8_t wire[128], pair[256]; size_t count;
  const uint8_t body[] = "{}";
  CHECK(hg_mesh_frame_encode(HG_MESH_EVENT, body, 2, wire, sizeof(wire), &count));
  memcpy(pair, wire, count); memcpy(pair+count, wire, count);
  for (int action = 0; action <= 4; ++action) {
    hg_mesh_frame_reader r; hg_mesh_frame_init(&r);
    observation o = {body, 2, 0, action, &r};
    CHECK(hg_mesh_frame_feed(&r, pair, count*2, sink, &o) == (action == 0));
    CHECK(o.calls == (action == 0 ? 2u : 1u));
    erased(&r);
    if (action) CHECK(!hg_mesh_frame_feed(&r, pair, count*2, sink, &o));
  }
  for (unsigned field = 0; field < HG_MESH_FRAME_HEADER; ++field) {
    uint8_t bad[128]; memcpy(bad, wire, count);
    /* Every header byte can independently make a frame invalid. */
    bad[field] = field < 8 ? 255 : field == 11 ? 0 : 255;
    hg_mesh_frame_reader r; hg_mesh_frame_init(&r);
    observation o = {body, 2, 0, 0, &r};
    CHECK(!hg_mesh_frame_feed(&r, bad, count, sink, &o));
    CHECK(o.calls == 0); erased(&r);
    CHECK(!hg_mesh_frame_feed(&r, wire, count, sink, &o));
  }
}

static void bounds(void) {
  uint8_t body[HG_MESH_FRAME_MAX_PAYLOAD], wire[HG_MESH_FRAME_MAX_PAYLOAD+HG_MESH_FRAME_HEADER];
  for (size_t i = 0; i < sizeof(body); ++i) body[i] = (uint8_t)i;
  size_t count = 123;
  CHECK(hg_mesh_frame_encode(HG_MESH_EVENT, body, sizeof(body), wire, sizeof(wire), &count));
  CHECK(count == sizeof(wire));
  hg_mesh_frame_reader r; hg_mesh_frame_init(&r);
  observation o = {body, sizeof(body), 0, 0, &r};
  CHECK(hg_mesh_frame_feed(&r, wire, count, sink, &o));
  CHECK(o.calls == 1); erased(&r);
  const uint8_t kinds[] = {1,2,3,4,16,17,18,19,20,32,33,34,48,49};
  for (unsigned kind = 0; kind < 256; ++kind) {
    int valid = 0;
    for (size_t i=0; i<sizeof(kinds); ++i) if (kind == kinds[i]) valid = 1;
    CHECK(hg_mesh_frame_encode((uint8_t)kind, body, 1, wire, sizeof(wire), &count) == valid);
    CHECK(count == (valid ? HG_MESH_FRAME_HEADER+1 : 0));
  }
  memset(wire, 0x71, sizeof(wire));
  CHECK(!hg_mesh_frame_encode(HG_MESH_EVENT, body, sizeof(body)+1, wire, sizeof(wire), &count));
  CHECK(count == 0 && wire[0] == 0x71);
  CHECK(!hg_mesh_frame_encode(HG_MESH_EVENT, body, sizeof(body), wire, sizeof(wire)-1, &count));
  CHECK(count == 0 && wire[0] == 0x71);
  CHECK(!hg_mesh_frame_encode(HG_MESH_EVENT, body, 0, wire, sizeof(wire), &count));
  CHECK(!hg_mesh_frame_encode(HG_MESH_EVENT, NULL, 1, wire, sizeof(wire), &count));
  CHECK(!hg_mesh_frame_encode(HG_MESH_EVENT, body, 1, NULL, sizeof(wire), &count));
  CHECK(!hg_mesh_frame_encode(HG_MESH_EVENT, body, 1, wire, sizeof(wire), NULL));
  CHECK(!hg_mesh_frame_feed(NULL, wire, 1, sink, &o));
  CHECK(!hg_mesh_frame_eof(NULL));
  hg_mesh_frame_init(&r);
  CHECK(!hg_mesh_frame_feed(&r, NULL, 1, sink, &o)); erased(&r);
  hg_mesh_frame_init(&r);
  CHECK(!hg_mesh_frame_feed(&r, wire, 1, NULL, &o)); erased(&r);
}

int main(void) {
  fragments(); terminal(); bounds();
  printf("{\"status\":\"passed\",\"assertions\":%u}\n", checks);
  return 0;
}
