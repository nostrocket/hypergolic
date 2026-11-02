#ifndef HYPERGOLIC_SIGNER_H
#define HYPERGOLIC_SIGNER_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Native-only primitive. Platform authority must own immutable review and one-use
 * approval before calling sign_digest. Never register this API with Expo/JS.
 * Handles are confined to their owning native serial executor. No concurrent use,
 * no calls after destroy. Secret import/serialization stay entirely native. */
typedef struct hypergolic_signer_key hypergolic_signer_key;
/* Fill every requested byte with OS CSPRNG output; return exactly 1 on success.
 * The callback must not retain the buffer or cross a JavaScript boundary. */
typedef int (*hypergolic_signer_entropy)(void *context, unsigned char *out, size_t length);

/* Synchronously consume the temporary scalar, for example by encrypting it into
 * protected native storage. Return exactly 1 on success. Do not retain the pointer,
 * call back into the signer, destroy the handle or cross a JavaScript boundary.
 * Any sink-owned copy must be protected and cleared by the native caller. */
typedef int (*hypergolic_signer_secret_sink)(void *context, const unsigned char *secret,
                                           size_t length);

/* All buffer sizes are exact requirements for the native caller; return 1/0.
 * Outputs are zeroed on failure. Generate/import set *out_key to NULL on failure. */
int hypergolic_signer_generate(hypergolic_signer_entropy entropy, void *context,
                              hypergolic_signer_key **out_key);
/* Import accepts exactly 32 bytes, with a nonzero scalar below the curve order.
 * The caller owns and clears its input. Fresh OS entropy randomizes the context. */
int hypergolic_signer_import(const unsigned char *secret, size_t secret_length,
                            hypergolic_signer_entropy entropy, void *context,
                            hypergolic_signer_key **out_key);
/* Derive a portable scalar with secp256k1, invoke the native sink once, then clear
 * the temporary buffer on every path. Never serialize the opaque keypair struct. */
int hypergolic_signer_serialize(const hypergolic_signer_key *key,
                               hypergolic_signer_secret_sink sink, void *context);
/* Validate an exact 32-byte BIP-340 x-only point; the native caller checks length. */
int hypergolic_signer_public_key_valid(const unsigned char public_key32[32]);
int hypergolic_signer_public_key(const hypergolic_signer_key *key, unsigned char out32[32]);
int hypergolic_signer_sign_digest(hypergolic_signer_key *key, const unsigned char digest32[32],
                                 hypergolic_signer_entropy entropy, void *context,
                                 unsigned char out64[64]);
int hypergolic_signer_verify_digest(const unsigned char public_key32[32],
                                   const unsigned char digest32[32],
                                   const unsigned char signature64[64]);
void hypergolic_signer_destroy(hypergolic_signer_key *key);
#ifdef __cplusplus
}
#endif
#endif
