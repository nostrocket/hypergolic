#include "hypergolic_mesh_frame.h"
#include <string.h>

static int valid_kind(uint8_t kind) {
  switch (kind) {
    case HG_MESH_PAIR_REQUEST: case HG_MESH_PAIR_BINDING:
    case HG_MESH_PAIR_COMMIT: case HG_MESH_AUTH: case HG_MESH_EVENT:
    case HG_MESH_BACKLOG_REQUEST: case HG_MESH_BACKLOG_EVENT:
    case HG_MESH_BACKLOG_END: case HG_MESH_BACKLOG_CANCEL:
    case HG_MESH_BLOBS_REQUEST: case HG_MESH_BLOBS_RESULT:
    case HG_MESH_BLOBS_CANCEL: case HG_MESH_PING: case HG_MESH_PONG:
      return 1;
    default: return 0;
  }
}

static void clear_bytes(void *memory, size_t length) {
  volatile uint8_t *bytes = memory;
  while (length--) *bytes++ = 0;
}

void hg_mesh_frame_init(hg_mesh_frame_reader *reader) {
  if (reader) memset(reader, 0, sizeof(*reader));
}

void hg_mesh_frame_close(hg_mesh_frame_reader *reader) {
  if (!reader) return;
  /* Do not erase a borrowed payload while its callback is using it. The outer
   * feed clears it immediately when that callback returns. */
  reader->closed = 1;
  if (!reader->feeding) {
    clear_bytes(reader->header, sizeof(reader->header));
    clear_bytes(reader->payload, sizeof(reader->payload));
    reader->header_used = reader->payload_used = reader->payload_length = 0;
    reader->kind = 0;
  }
}

static int header(hg_mesh_frame_reader *reader) {
  const uint8_t *h = reader->header;
  if (memcmp(h, "HGM1", 4) != 0 || h[4] != 1 || !valid_kind(h[5]) ||
      h[6] != 0 || h[7] != 0) return 0;
  const uint32_t count = ((uint32_t)h[8] << 24) | ((uint32_t)h[9] << 16) |
                         ((uint32_t)h[10] << 8) | h[11];
  if (count == 0 || count > HG_MESH_FRAME_MAX_PAYLOAD) return 0;
  reader->kind = h[5];
  reader->payload_length = count;
  return 1;
}

int hg_mesh_frame_feed(hg_mesh_frame_reader *reader, const uint8_t *bytes,
                       size_t length, hg_mesh_frame_sink sink, void *context) {
  if (!reader) return 0;
  if (reader->closed || reader->feeding || !sink || (!bytes && length)) {
    hg_mesh_frame_close(reader);
    return 0;
  }
  reader->feeding = 1;
  while (length && !reader->closed) {
    if (reader->header_used < HG_MESH_FRAME_HEADER) {
      size_t count = HG_MESH_FRAME_HEADER - reader->header_used;
      if (count > length) count = length;
      memcpy(reader->header + reader->header_used, bytes, count);
      reader->header_used += count; bytes += count; length -= count;
      if (reader->header_used < HG_MESH_FRAME_HEADER) break;
      if (!header(reader)) { reader->closed = 1; break; }
    }
    size_t count = reader->payload_length - reader->payload_used;
    if (count > length) count = length;
    if (count) memcpy(reader->payload + reader->payload_used, bytes, count);
    reader->payload_used += count; bytes += count; length -= count;
    if (reader->payload_used < reader->payload_length) break;
    const int accepted = sink(context, reader->kind, reader->payload,
                              reader->payload_length);
    clear_bytes(reader->payload, reader->payload_used);
    clear_bytes(reader->header, sizeof(reader->header));
    reader->header_used = reader->payload_used = reader->payload_length = 0;
    reader->kind = 0;
    if (accepted != 1) reader->closed = 1;
  }
  reader->feeding = 0;
  if (reader->closed) hg_mesh_frame_close(reader);
  return !reader->closed;
}

int hg_mesh_frame_eof(hg_mesh_frame_reader *reader) {
  if (!reader) return 0;
  const int clean = !reader->closed && !reader->feeding &&
                    reader->header_used == 0 && reader->payload_used == 0;
  hg_mesh_frame_close(reader);
  return clean;
}

int hg_mesh_frame_encode(uint8_t kind, const uint8_t *payload, size_t length,
                         uint8_t *output, size_t capacity, size_t *written) {
  if (written) *written = 0;
  if (!written || !valid_kind(kind) || !payload || !output || length == 0 ||
      length > HG_MESH_FRAME_MAX_PAYLOAD ||
      capacity < HG_MESH_FRAME_HEADER + length) return 0;
  const uint32_t count = (uint32_t)length;
  memcpy(output, "HGM1", 4);
  output[4] = 1; output[5] = kind; output[6] = output[7] = 0;
  output[8] = (uint8_t)(count >> 24); output[9] = (uint8_t)(count >> 16);
  output[10] = (uint8_t)(count >> 8); output[11] = (uint8_t)count;
  memcpy(output + HG_MESH_FRAME_HEADER, payload, length);
  *written = HG_MESH_FRAME_HEADER + length;
  return 1;
}
