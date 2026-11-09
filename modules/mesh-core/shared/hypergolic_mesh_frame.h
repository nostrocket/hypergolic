#ifndef HYPERGOLIC_MESH_FRAME_H
#define HYPERGOLIC_MESH_FRAME_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Plaintext framing INSIDE an authenticated TLS connection. These routines do
 * not authenticate peers, validate JSON, authorize a message or perform IO. */
#define HG_MESH_FRAME_HEADER 12u
#define HG_MESH_FRAME_MAX_PAYLOAD 32768u

enum hg_mesh_frame_kind {
  HG_MESH_PAIR_REQUEST = 1,
  HG_MESH_PAIR_BINDING = 2,
  HG_MESH_PAIR_COMMIT = 3,
  HG_MESH_AUTH = 4,
  HG_MESH_EVENT = 16,
  HG_MESH_BACKLOG_REQUEST = 17,
  HG_MESH_BACKLOG_EVENT = 18,
  HG_MESH_BACKLOG_END = 19,
  HG_MESH_BACKLOG_CANCEL = 20,
  HG_MESH_BLOBS_REQUEST = 32,
  HG_MESH_BLOBS_RESULT = 33,
  HG_MESH_BLOBS_CANCEL = 34,
  HG_MESH_PING = 48,
  HG_MESH_PONG = 49
};

/* Borrowed payload is valid only during this synchronous callback. Return 1
 * after accepting it, or 0 to close. The owner must check phase, pairing and
 * current authority before interpreting or dispatching the payload. */
typedef int (*hg_mesh_frame_sink)(void *context, uint8_t kind,
                                  const uint8_t *payload, size_t length);

typedef struct {
  uint8_t header[HG_MESH_FRAME_HEADER];
  uint8_t payload[HG_MESH_FRAME_MAX_PAYLOAD];
  size_t header_used, payload_used, payload_length;
  uint8_t kind, closed, feeding;
} hg_mesh_frame_reader;

void hg_mesh_frame_init(hg_mesh_frame_reader *reader);
/* Close is sticky, including malformed input, callback refusal, reentrant feed
 * and EOF. Create a new reader only for a separately authenticated connection. */
void hg_mesh_frame_close(hg_mesh_frame_reader *reader);
int hg_mesh_frame_feed(hg_mesh_frame_reader *reader, const uint8_t *bytes,
                       size_t length, hg_mesh_frame_sink sink, void *context);
/* Returns 1 only for clean EOF between complete frames. Always closes. */
int hg_mesh_frame_eof(hg_mesh_frame_reader *reader);
/* Caller-owned output; no allocation or IO. Input and output must not overlap. */
int hg_mesh_frame_encode(uint8_t kind, const uint8_t *payload, size_t length,
                         uint8_t *output, size_t capacity, size_t *written);

#ifdef __cplusplus
}
#endif
#endif
