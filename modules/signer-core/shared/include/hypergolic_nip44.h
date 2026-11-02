#ifndef HYPERGOLIC_NIP44_H
#define HYPERGOLIC_NIP44_H
#include "hypergolic_signer.h"
#ifdef __cplusplus
extern "C" {
#endif

/* Native-only NIP-46 transport crypto. Never register with Expo or forward to JS.
 * The caller MUST verify the outer NIP-01 event and exact peer before decrypting.
 * Handles and callbacks remain on their owning native serial executor. */
#define HYPERGOLIC_NIP44_MAX_PLAINTEXT ((size_t)4202496)
#define HYPERGOLIC_NIP44_MAX_PAYLOAD ((size_t)6990604)
/* A read-only native buffer borrowed for this synchronous call. The caller keeps
 * data alive; passing the span never transfers ownership or copies its bytes. */
typedef struct {
    const unsigned char *data;
    size_t length;
} hypergolic_nip44_bytes;

typedef enum {
    HYPERGOLIC_NIP44_OK = 1,
    HYPERGOLIC_NIP44_INVALID = 0,
    HYPERGOLIC_NIP44_UNSUPPORTED_VERSION = -1,
    HYPERGOLIC_NIP44_AUTH_FAILED = -2,
    HYPERGOLIC_NIP44_CRYPTO_FAILED = -3,
    HYPERGOLIC_NIP44_OUTPUT_FAILED = -4
} hypergolic_nip44_status;

/* Supply the platform's HMAC-SHA256 primitive. Return exactly one on success.
 * Never retain pointers or cross JS; protect and clear any native-owned copies.
 * Key length is variable: HKDF salt is 8 bytes; remaining keys are 32 bytes. */
typedef int (*hypergolic_nip44_hmac)(void *context, const unsigned char *key, size_t key_length,
                                    const unsigned char *message, size_t message_length,
                                    unsigned char out32[32]);
typedef struct {
    hypergolic_nip44_hmac hmac;
    void *hmac_context;
    hypergolic_signer_entropy entropy;
    void *entropy_context;
} hypergolic_nip44_crypto;
/* A synchronous native sink receives a temporary UTF-8 plaintext or ASCII base64
 * buffer, cleared before return. Return exactly one. Do not reenter, destroy the
 * handle, retain the pointer, throw/longjmp or cross JS. Any copy is caller-owned. */
typedef int (*hypergolic_nip44_sink)(void *context, const unsigned char *bytes, size_t length);
hypergolic_nip44_status hypergolic_nip44_encrypt(const hypergolic_signer_key *key,
    hypergolic_nip44_bytes peer_bytes, hypergolic_nip44_bytes input_bytes,
    const hypergolic_nip44_crypto *crypto, hypergolic_nip44_sink sink, void *sink_context);
hypergolic_nip44_status hypergolic_nip44_decrypt(const hypergolic_signer_key *key,
    hypergolic_nip44_bytes peer_bytes, hypergolic_nip44_bytes input_bytes,
    const hypergolic_nip44_crypto *crypto, hypergolic_nip44_sink sink, void *sink_context);
#ifdef __cplusplus
}
#endif
#endif
