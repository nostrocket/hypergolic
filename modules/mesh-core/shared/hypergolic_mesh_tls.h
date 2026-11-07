#ifndef HYPERGOLIC_MESH_TLS_H
#define HYPERGOLIC_MESH_TLS_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define HG_MESH_TLS_PIN_BYTES 32
#define HG_MESH_TLS_CREDENTIAL_MAX 2048
#define HG_MESH_TLS_IO_MAX 16384
#define HG_MESH_TLS_HANDSHAKE_MAX_MS 30000
#define HG_MESH_TLS_HANDSHAKE_BYTES 65536
/* Native-only API. Caller serializes each credential/session and holds callback
 * owners until destroy. TLS confers no Mesh/source/account/pairing authority.
 * All BIO callbacks are nonblocking, return a byte count, -1 for would-block,
 * or -2 for failure. No callback may reenter this API. No socket is opened here.
 * The native send callback must atomically recheck its own source/connection
 * authority with enqueue. DENIED after a callback is not proof of zero sent bytes. */
typedef struct hg_mesh_tls_credential hg_mesh_tls_credential;
typedef struct hg_mesh_tls hg_mesh_tls;
typedef struct {
  void *context;
  int (*random)(void *, unsigned char *, size_t); /* 1 = fully filled by OS CSPRNG */
  int (*current)(void *); /* 1 = unlocked/current native owner; revocation fails closed */
  uint64_t (*monotonic_ms)(void *);
} hg_mesh_tls_owner;
typedef struct {
  void *context;
  int (*send)(void *, const unsigned char *, size_t);
  int (*receive)(void *, unsigned char *, size_t);
} hg_mesh_tls_io;
typedef enum {
  HG_MESH_TLS_OK = 0,
  HG_MESH_TLS_WANT_IO = 1,
  HG_MESH_TLS_CLOSED = 2,
  HG_MESH_TLS_INVALID = -1,
  HG_MESH_TLS_DENIED = -2,
  HG_MESH_TLS_FAILED = -3
} hg_mesh_tls_result;
/* UTC validity fields are exact YYYYMMDDhhmmss, native supplied. Credentials
 * are P256, self-signed private device trust anchors, both client/server usage.
 * The CA flag never permits issued chains: exact one-cert/SPKI pins are mandatory. No Nostr keys. */
hg_mesh_tls_result hg_mesh_tls_credential_generate(hg_mesh_tls_owner owner,
  const char *not_before, const char *not_after, hg_mesh_tls_credential **out);
hg_mesh_tls_result hg_mesh_tls_credential_import(hg_mesh_tls_owner owner,
  const unsigned char *key_der, size_t key_len,
  const unsigned char *certificate_der, size_t certificate_len,
  hg_mesh_tls_credential **out);
/* Sink is a trusted native secure-storage callback. Temporary DER secret bytes
 * are erased immediately after it returns. No JS/Expo string/key getter. */
hg_mesh_tls_result hg_mesh_tls_credential_store(hg_mesh_tls_credential *,
  int (*sink)(void *, const unsigned char *, size_t, const unsigned char *, size_t), void *);
hg_mesh_tls_result hg_mesh_tls_credential_pin(hg_mesh_tls_credential *, unsigned char out[32]);
/* Revoke now; actual key destruction waits for retained sessions to destroy. */
void hg_mesh_tls_credential_destroy(hg_mesh_tls_credential *);
/* Paired mode only: both roles REQUIRE a certificate and an exact stored SPKI
 * SHA256 pin. No pre-pair/trust-any mode exists in this backend. Deadline is the
 * original native absolute handshake deadline, never extended by WANT_IO.
 * After handshake, each nonblocking read/write still rechecks current owner;
 * the native connection owner controls its own overall connection lifetime. */
typedef struct {
  int server;
  hg_mesh_tls_credential *credential;
  const unsigned char *peer_pin;
  hg_mesh_tls_owner owner;
  hg_mesh_tls_io io;
  uint64_t deadline_ms;
} hg_mesh_tls_parameters;
hg_mesh_tls_result hg_mesh_tls_create(const hg_mesh_tls_parameters *, hg_mesh_tls **out);
hg_mesh_tls_result hg_mesh_tls_handshake(hg_mesh_tls *);
/* The wrapper owns a <=16KiB immutable pending copy. WANT_IO retries MUST match
 * its exact remaining bytes/length; mismatch closes the channel with no flush.
 * While pending, read/handshake return WANT_IO without advancing output. The
 * native coordinator must retain the ORIGINAL frame/source permit until actual
 * drain; cancel closes the channel with unknown partial delivery, never replay.
 * Raw receive buffering must continue independently of TLS plaintext reads. */
hg_mesh_tls_result hg_mesh_tls_write(hg_mesh_tls *, const unsigned char *, size_t, size_t *written);
hg_mesh_tls_result hg_mesh_tls_read(hg_mesh_tls *, unsigned char *, size_t, size_t *read);
void hg_mesh_tls_cancel(hg_mesh_tls *);
void hg_mesh_tls_destroy(hg_mesh_tls *);
#ifdef __cplusplus
}
#endif
#endif
