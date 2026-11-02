#include "hypergolic_signer.h"
#include "secp256k1.h"
#include "secp256k1_preallocated.h"
#include "secp256k1_extrakeys.h"
#include "secp256k1_schnorrsig.h"
#include <stdlib.h>
#include <string.h>

struct hypergolic_signer_key {
    secp256k1_context *context;
    void *context_memory;
    size_t context_size;
    secp256k1_keypair keypair;
};

/* Volatile writes keep this cleanup observable to the C abstract machine.
 * This bounds owned buffers; it is not a claim about registers or process isolation. */
static void clear_memory(void *memory, size_t length) {
    volatile unsigned char *bytes = (volatile unsigned char *)memory;
    size_t remaining = length;
    while (remaining--) *bytes++ = 0;
#ifdef HYPERGOLIC_SIGNER_TEST_CLEAR
    /* Host-only observation runs while stack buffers are still alive. */
    extern void signer_test_cleared_memory(const void *memory, size_t length);
    signer_test_cleared_memory(memory, length);
#endif
}

void hypergolic_signer_destroy(hypergolic_signer_key *key) {
    if (!key) return;
    if (key->context) secp256k1_context_preallocated_destroy(key->context);
    if (key->context_memory) {
        clear_memory(key->context_memory, key->context_size);
        free(key->context_memory);
    }
    clear_memory(key, sizeof(*key));
    free(key);
}

/* Both creation paths require the same native entropy and randomized context. */
static hypergolic_signer_key *create_randomized_key(hypergolic_signer_entropy entropy,
                                                   void *context) {
    hypergolic_signer_key *key = NULL;
    unsigned char randomizer[32] = {0};
    int success = 0;
    if (!entropy) return NULL;
    key = (hypergolic_signer_key *)calloc(1, sizeof(*key));
    if (!key) goto cleanup;
    key->context_size = secp256k1_context_preallocated_size(SECP256K1_CONTEXT_NONE);
    key->context_memory = calloc(1, key->context_size);
    if (!key->context_memory) goto cleanup;
    key->context = secp256k1_context_preallocated_create(key->context_memory, SECP256K1_CONTEXT_NONE);
    if (!key->context || entropy(context, randomizer, sizeof(randomizer)) != 1 ||
        !secp256k1_context_randomize(key->context, randomizer)) goto cleanup;
    success = 1;
cleanup:
    clear_memory(randomizer, sizeof(randomizer));
    if (!success) {
        hypergolic_signer_destroy(key);
        key = NULL;
    }
    return key;
}

int hypergolic_signer_generate(hypergolic_signer_entropy entropy, void *context,
                              hypergolic_signer_key **out_key) {
    hypergolic_signer_key *key = NULL;
    unsigned char secret[32] = {0};
    unsigned int attempt;
    int success = 0;
    if (!out_key) return 0;
    *out_key = NULL;
    key = create_randomized_key(entropy, context);
    if (!key) goto cleanup;
    /* Rejection sampling, bounded to fail closed on a broken entropy source. */
    for (attempt = 0; attempt < 128; ++attempt) {
        if (entropy(context, secret, sizeof(secret)) != 1) goto cleanup;
        if (secp256k1_ec_seckey_verify(key->context, secret)) {
            success = secp256k1_keypair_create(key->context, &key->keypair, secret);
            break;
        }
        clear_memory(secret, sizeof(secret));
    }
cleanup:
    clear_memory(secret, sizeof(secret));
    if (success) *out_key = key;
    else hypergolic_signer_destroy(key);
    return success;
}

int hypergolic_signer_import(const unsigned char *input, size_t secret_length,
                            hypergolic_signer_entropy entropy, void *context,
                            hypergolic_signer_key **out_key) {
    hypergolic_signer_key *key = NULL;
    unsigned char secret[32] = {0};
    int success = 0;
    if (!out_key) return 0;
    *out_key = NULL;
    if (!input || secret_length != sizeof(secret) || !entropy) return 0;
    memcpy(secret, input, sizeof(secret));
    if (!secp256k1_ec_seckey_verify(secp256k1_context_static, secret)) goto cleanup;
    key = create_randomized_key(entropy, context);
    if (!key) goto cleanup;
    success = secp256k1_keypair_create(key->context, &key->keypair, secret);
cleanup:
    clear_memory(secret, sizeof(secret));
    if (success) *out_key = key;
    else hypergolic_signer_destroy(key);
    return success;
}

int hypergolic_signer_serialize(const hypergolic_signer_key *key,
                               hypergolic_signer_secret_sink sink, void *context) {
    unsigned char secret[32] = {0};
    int success = 0;
    if (!key || !sink) goto cleanup;
    if (!secp256k1_keypair_sec(key->context, secret, &key->keypair)) goto cleanup;
    success = sink(context, secret, sizeof(secret)) == 1;
cleanup:
    clear_memory(secret, sizeof(secret));
    return success;
}

int hypergolic_signer_public_key(const hypergolic_signer_key *key, unsigned char out32[32]) {
    secp256k1_xonly_pubkey public_key;
    if (!out32) return 0;
    memset(out32, 0, 32);
    if (!key) return 0;
    if (!secp256k1_keypair_xonly_pub(key->context, &public_key, NULL, &key->keypair)) return 0;
    return secp256k1_xonly_pubkey_serialize(key->context, out32, &public_key);
}

int hypergolic_signer_sign_digest(hypergolic_signer_key *key, const unsigned char digest32[32],
                                 hypergolic_signer_entropy entropy, void *context,
                                 unsigned char out64[64]) {
    unsigned char randomness[64] = {0}, signature[64] = {0};
    int success = 0;
    if (!out64) return 0;
    memset(out64, 0, 64);
    if (!key || !digest32 || !entropy) return 0;
    if (entropy(context, randomness, sizeof(randomness)) != 1) goto cleanup;
    if (!secp256k1_context_randomize(key->context, randomness)) goto cleanup;
    if (!secp256k1_schnorrsig_sign32(key->context, signature, digest32,
                                    &key->keypair, randomness + 32)) goto cleanup;
    success = 1;
    memcpy(out64, signature, 64);
cleanup:
    clear_memory(signature, sizeof(signature));
    clear_memory(randomness, sizeof(randomness));
    return success;
}

int hypergolic_signer_public_key_valid(const unsigned char public_key32[32]) {
    secp256k1_xonly_pubkey public_key;
    if (!public_key32) return 0;
    return secp256k1_xonly_pubkey_parse(secp256k1_context_static, &public_key, public_key32);
}

int hypergolic_signer_verify_digest(const unsigned char public_key32[32],
                                   const unsigned char digest32[32],
                                   const unsigned char signature64[64]) {
    secp256k1_xonly_pubkey public_key;
    if (!public_key32 || !digest32 || !signature64) return 0;
    if (!secp256k1_xonly_pubkey_parse(secp256k1_context_static, &public_key, public_key32)) return 0;
    return secp256k1_schnorrsig_verify(secp256k1_context_static, signature64, digest32, 32, &public_key);
}

/* Private C-to-C path: no scalar or ECDH material crosses the native module. */
#include "hypergolic_signer_internal.h"
#include "secp256k1_ecdh.h"
static int copy_shared_x(unsigned char *output, const unsigned char *x32,
                         const unsigned char *y32, void *context) {
    (void)y32; (void)context;
    memcpy(output, x32, 32);
    return 1;
}
int hypergolic_signer_shared_x(const hypergolic_signer_key *key,
                               const unsigned char peer32[32], unsigned char out32[32]) {
    unsigned char secret[32] = {0}, compressed[33] = {0};
    secp256k1_pubkey peer;
    int success = 0;
    if (!out32) return 0;
    memset(out32, 0, 32);
    if (!key || !peer32) goto cleanup;
    compressed[0] = 2; /* BIP-340 lift_x uses the even-y representative. */
    memcpy(compressed + 1, peer32, 32);
    if (!secp256k1_ec_pubkey_parse(key->context, &peer, compressed, sizeof(compressed))) goto cleanup;
    if (!secp256k1_keypair_sec(key->context, secret, &key->keypair)) goto cleanup;
    success = secp256k1_ecdh(key->context, out32, &peer, secret, copy_shared_x, NULL);
cleanup:
    clear_memory(secret, sizeof(secret));
    if (!success) clear_memory(out32, 32);
    return success;
}
