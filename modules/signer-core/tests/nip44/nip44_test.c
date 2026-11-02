#include "hypergolic_nip44.h"
#include "monocypher.h"
#include <CommonCrypto/CommonHMAC.h>
#include <CommonCrypto/CommonDigest.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned int assertions, allocations_live, cleanups, allocation_calls, sink_calls, hmac_calls;
static int allocation_failure = -1, entropy_result = 1, hmac_failure = 0, hmac_result = 1, sink_result = 1;
static unsigned char nonce[32];
static const void *sink_address;
static size_t sink_length;
static unsigned int sink_cleanups;
struct allocation { void *pointer; size_t size; };
static struct allocation owned[16];
static void check(int condition, unsigned int line) {
    ++assertions;
    if (!condition) { fprintf(stderr, "Assertion failed at line %u\n", line); exit(1); }
}
#define CHECK(x) check(!!(x), __LINE__)
static int zero(const void *memory, size_t size) {
    const unsigned char *bytes = memory; size_t i;
    for (i = 0; i < size; ++i) if (bytes[i]) return 0;
    return 1;
}
void nip44_test_cleared(const void *memory, size_t size) {
    CHECK(zero(memory, size)); ++cleanups;
    if (sink_address && (uintptr_t)sink_address >= (uintptr_t)memory &&
        (uintptr_t)sink_address + sink_length <= (uintptr_t)memory + size) {
        sink_address = NULL; ++sink_cleanups;
    }
}
void signer_test_cleared_memory(const void *memory, size_t size) { nip44_test_cleared(memory, size); }
void *nip44_test_calloc(size_t count, size_t size) {
    void *pointer; size_t i;
    ++allocation_calls;
    if (allocation_failure == 0) return NULL;
    if (allocation_failure > 0) --allocation_failure;
    pointer = calloc(count, size);
    if (!pointer) return NULL;
    for (i = 0; i < 16; ++i) if (!owned[i].pointer) {
        owned[i].pointer = pointer; owned[i].size = count * size; ++allocations_live; return pointer;
    }
    abort();
}
void nip44_test_free(void *pointer) {
    size_t i;
    for (i = 0; i < 16; ++i) if (owned[i].pointer == pointer) {
        CHECK(zero(pointer, owned[i].size)); owned[i].pointer = NULL; --allocations_live; free(pointer); return;
    }
    abort();
}
static int entropy(void *context, unsigned char *out, size_t length) {
    (void)context;
    CHECK(length == 32);
    memcpy(out, nonce, entropy_result == 3 ? 1 : length);
    return entropy_result == 3 ? 0 : entropy_result;
}
static int import_entropy(void *context, unsigned char *out, size_t length) {
    (void)context; memset(out, 0x42, length); return 1;
}
static int hmac(void *context, const unsigned char *key, size_t key_length,
                 const unsigned char *message, size_t message_length, unsigned char out[32]) {
    (void)context; ++hmac_calls;
    if (hmac_failure && hmac_calls == (unsigned int)hmac_failure) { memset(out, 0x42, 13); return hmac_result == 1 ? 0 : hmac_result; }
    CCHmac(kCCHmacAlgSHA256, key, key_length, message, message_length, out);
    return 1;
}
static hypergolic_nip44_crypto crypto = {hmac, NULL, entropy, NULL};
struct output { unsigned char *data; size_t length; };
static void clear_output(struct output *output) {
    if (output->data) { crypto_wipe(output->data, output->length); free(output->data); }
    output->data = NULL; output->length = 0;
}
static int capture(void *opaque, const unsigned char *bytes, size_t length) {
    struct output *output = opaque;
    clear_output(output); ++sink_calls;
    output->data = malloc(length); CHECK(output->data);
    memcpy(output->data, bytes, length); output->length = length;
    sink_address = bytes; sink_length = length;
    return sink_result;
}
static void unhex(const char *hex, unsigned char *bytes, size_t size) {
    size_t i; unsigned int value;
    CHECK(strlen(hex) == 2 * size);
    for (i = 0; i < size; ++i) { CHECK(sscanf(hex + i * 2, "%2x", &value) == 1); bytes[i] = (unsigned char)value; }
}
size_t nip44_test_padded_length(size_t length);
int nip44_test_conversation(const hypergolic_signer_key *, const unsigned char *, const hypergolic_nip44_crypto *, unsigned char *);
int nip44_test_message_keys(const unsigned char *, const unsigned char *, const hypergolic_nip44_crypto *, unsigned char *);
hypergolic_nip44_status nip44_test_encrypt(const unsigned char *, const unsigned char *, size_t, const hypergolic_nip44_crypto *, hypergolic_nip44_sink, void *);
hypergolic_nip44_status nip44_test_decrypt(const unsigned char *, const unsigned char *, size_t, const hypergolic_nip44_crypto *, hypergolic_nip44_sink, void *);
static hypergolic_signer_key *import_key(const char *hex) {
    unsigned char scalar[32]; hypergolic_signer_key *key = NULL;
    unhex(hex, scalar, 32); CHECK(hypergolic_signer_import(scalar, 32, import_entropy, NULL, &key));
    crypto_wipe(scalar, sizeof(scalar)); return key;
}
static void check_conversation(const char *secret, const char *peer, const char *expected) {
    hypergolic_signer_key *key = import_key(secret);
    unsigned char public_key[32], actual[32], wanted[32];
    unhex(peer, public_key, 32); unhex(expected, wanted, 32);
    CHECK(nip44_test_conversation(key, public_key, &crypto, actual)); CHECK(!memcmp(wanted, actual, 32));
    crypto_wipe(actual, sizeof(actual)); hypergolic_signer_destroy(key);
}
static void check_invalid_conversation(const char *secret, const char *peer) {
    unsigned char scalar[32], public_key[32], actual[32]; hypergolic_signer_key *key = NULL;
    unhex(secret, scalar, 32); unhex(peer, public_key, 32);
    if (hypergolic_signer_import(scalar, 32, import_entropy, NULL, &key)) {
        memset(actual, 0xff, 32); CHECK(!nip44_test_conversation(key, public_key, &crypto, actual)); CHECK(zero(actual, 32));
        hypergolic_signer_destroy(key);
    } else CHECK(key == NULL);
    crypto_wipe(scalar, sizeof(scalar));
}
static void check_keys(const char *conversation, const char *nonce_hex, const char *expected) {
    unsigned char key[32], actual[76], wanted[76];
    unhex(conversation, key, 32); unhex(nonce_hex, nonce, 32); unhex(expected, wanted, 76);
    CHECK(nip44_test_message_keys(key, nonce, &crypto, actual)); CHECK(!memcmp(actual, wanted, 76));
    crypto_wipe(key, 32); crypto_wipe(actual, 76);
}
static void check_roundtrip(const char *secret1, const char *secret2, const char *nonce_hex, const char *plaintext_hex, const char *payload) {
    hypergolic_signer_key *one = import_key(secret1), *two = import_key(secret2);
    unsigned char pub1[32], pub2[32], plaintext[1000]; size_t length = strlen(plaintext_hex) / 2;
    struct output encrypted = {NULL, 0}, decrypted = {NULL, 0};
    unhex(nonce_hex, nonce, 32); CHECK(length <= sizeof(plaintext)); unhex(plaintext_hex, plaintext, length);
    CHECK(hypergolic_signer_public_key(one, pub1)); CHECK(hypergolic_signer_public_key(two, pub2));
    CHECK(hypergolic_nip44_encrypt(one, (hypergolic_nip44_bytes){pub2, 32}, (hypergolic_nip44_bytes){plaintext, length}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_OK);
    CHECK(encrypted.length == strlen(payload)); CHECK(!memcmp(encrypted.data, payload, encrypted.length)); CHECK(sink_address == NULL);
    CHECK(hypergolic_nip44_decrypt(two, (hypergolic_nip44_bytes){pub1, 32}, (hypergolic_nip44_bytes){encrypted.data, encrypted.length}, &crypto, capture, &decrypted) == HYPERGOLIC_NIP44_OK);
    CHECK(decrypted.length == length); CHECK(!memcmp(decrypted.data, plaintext, length)); CHECK(sink_address == NULL);
    clear_output(&encrypted); clear_output(&decrypted); hypergolic_signer_destroy(one); hypergolic_signer_destroy(two);
}
static void check_invalid_payload(const char *conversation, const char *payload_hex) {
    unsigned char key[32], payload[2000]; size_t length = strlen(payload_hex) / 2;
    struct output output = {NULL, 0}; unsigned int before = sink_calls;
    unhex(conversation, key, 32); CHECK(length <= sizeof(payload)); unhex(payload_hex, payload, length);
    CHECK(nip44_test_decrypt(key, payload, length, &crypto, capture, &output) != HYPERGOLIC_NIP44_OK);
    CHECK(sink_calls == before); CHECK(output.data == NULL); crypto_wipe(key, sizeof(key));
}
static void check_digest(const void *bytes, size_t length, const char *expected) {
    unsigned char actual[32], wanted[32];
    CHECK(length <= UINT32_MAX); unhex(expected, wanted, 32);
    CC_SHA256(bytes, (CC_LONG)length, actual); CHECK(!memcmp(actual, wanted, 32));
}
static void check_long(const char *conversation, const char *nonce_hex, const char *pattern_hex,
                        size_t repeat, const char *plaintext_hash, const char *payload_hash) {
    unsigned char key[32], pattern[20], *plaintext; size_t pattern_length = strlen(pattern_hex) / 2, length = repeat * pattern_length, i;
    struct output encrypted = {NULL, 0}, decrypted = {NULL, 0};
    unhex(conversation, key, 32); unhex(nonce_hex, nonce, 32); CHECK(pattern_length <= sizeof(pattern)); unhex(pattern_hex, pattern, pattern_length);
    plaintext = malloc(length); CHECK(plaintext);
    for (i = 0; i < repeat; ++i) memcpy(plaintext + i * pattern_length, pattern, pattern_length);
    if (plaintext_hash) check_digest(plaintext, length, plaintext_hash);
    CHECK(nip44_test_encrypt(key, plaintext, length, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_OK); CHECK(sink_address == NULL);
    if (payload_hash) check_digest(encrypted.data, encrypted.length, payload_hash);
    CHECK(nip44_test_decrypt(key, encrypted.data, encrypted.length, &crypto, capture, &decrypted) == HYPERGOLIC_NIP44_OK);
    CHECK(decrypted.length == length); CHECK(!memcmp(decrypted.data, plaintext, length)); CHECK(sink_address == NULL);
    if (length == HYPERGOLIC_NIP44_MAX_PLAINTEXT || length == 65535 || length == 65536 || length == 65537) {
        char name[80]; FILE *file; snprintf(name, sizeof(name), "interop-%lu.b64", (unsigned long)length);
        file = fopen(name, "wb"); CHECK(file); CHECK(fwrite(encrypted.data, 1, encrypted.length, file) == encrypted.length); CHECK(!fclose(file));
    }
    clear_output(&encrypted); clear_output(&decrypted); crypto_wipe(plaintext, length); free(plaintext); crypto_wipe(key, 32);
}
#include "vectors.inc"
static void faults(void) {
    hypergolic_signer_key *key = import_key("0000000000000000000000000000000000000000000000000000000000000001");
    unsigned char peer[32], one = 'a', malformed[] = {0xed,0xa0,0x80}; unsigned int before, i;
    struct output encrypted = {NULL, 0}, decrypted = {NULL, 0};
    CHECK(hypergolic_signer_public_key(key, peer));
    for (i = 0; i <= 1; ++i) {
        allocation_failure = (int)i; before = sink_calls;
        CHECK(hypergolic_nip44_encrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){&one, 1}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_CRYPTO_FAILED);
        CHECK(sink_calls == before); CHECK(allocations_live == 2);
    }
    allocation_failure = -1;
    for (i = 0; i < 3; ++i) {
        entropy_result = i == 0 ? 0 : (int)i + 1; before = sink_calls;
        CHECK(hypergolic_nip44_encrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){&one, 1}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_CRYPTO_FAILED);
        CHECK(sink_calls == before); CHECK(allocations_live == 2);
    }
    entropy_result = 1;
    for (i = 1; i <= 5; ++i) {
        hmac_calls = 0; hmac_failure = (int)i; before = sink_calls;
        CHECK(hypergolic_nip44_encrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){&one, 1}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_CRYPTO_FAILED);
        CHECK(sink_calls == before); CHECK(allocations_live == 2);
    }
    hmac_calls = 0; hmac_failure = 2; hmac_result = 2;
    CHECK(hypergolic_nip44_encrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){&one, 1}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_CRYPTO_FAILED);
    hmac_failure = 0; hmac_result = 1;
    before = allocation_calls;
    CHECK(hypergolic_nip44_encrypt(key, (hypergolic_nip44_bytes){peer, 33}, (hypergolic_nip44_bytes){&one, 1}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_INVALID);
    CHECK(hypergolic_nip44_encrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){&one, HYPERGOLIC_NIP44_MAX_PLAINTEXT + 1}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_INVALID);
    CHECK(hypergolic_nip44_decrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){&one, HYPERGOLIC_NIP44_MAX_PAYLOAD + 1}, &crypto, capture, &decrypted) == HYPERGOLIC_NIP44_INVALID);
    CHECK(hypergolic_nip44_encrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){malformed, sizeof(malformed)}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_INVALID);
    CHECK(allocation_calls == before);
    sink_result = 0; before = sink_cleanups;
    CHECK(hypergolic_nip44_encrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){&one, 1}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_OUTPUT_FAILED);
    CHECK(sink_cleanups == before + 1); CHECK(sink_address == NULL);
    sink_result = 1;
    CHECK(hypergolic_nip44_encrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){&one, 1}, &crypto, capture, &encrypted) == HYPERGOLIC_NIP44_OK);
    allocation_failure = 0; before = sink_calls;
    CHECK(hypergolic_nip44_decrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){encrypted.data, encrypted.length}, &crypto, capture, &decrypted) == HYPERGOLIC_NIP44_CRYPTO_FAILED);
    CHECK(sink_calls == before); allocation_failure = -1;
    for (i = 1; i <= 5; ++i) {
        hmac_failure = (int)i; hmac_calls = 0; before = sink_calls;
        CHECK(hypergolic_nip44_decrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){encrypted.data, encrypted.length}, &crypto, capture, &decrypted) == HYPERGOLIC_NIP44_CRYPTO_FAILED);
        CHECK(sink_calls == before); CHECK(allocations_live == 2);
    }
    hmac_failure = 0;
    sink_result = 2; before = sink_cleanups;
    CHECK(hypergolic_nip44_decrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){encrypted.data, encrypted.length}, &crypto, capture, &decrypted) == HYPERGOLIC_NIP44_OUTPUT_FAILED);
    CHECK(sink_cleanups == before + 1); CHECK(sink_address == NULL); sink_result = 1;
    {
        hypergolic_signer_key *other = import_key("0000000000000000000000000000000000000000000000000000000000000002");
        unsigned char other_peer[32];
        CHECK(hypergolic_signer_public_key(other, other_peer)); before = sink_calls;
        CHECK(hypergolic_nip44_decrypt(key, (hypergolic_nip44_bytes){other_peer, 32}, (hypergolic_nip44_bytes){encrypted.data, encrypted.length}, &crypto, capture, &decrypted) == HYPERGOLIC_NIP44_AUTH_FAILED);
        CHECK(sink_calls == before); hypergolic_signer_destroy(other);
    }
    encrypted.data[20] = encrypted.data[20] == 'A' ? 'B' : 'A'; before = sink_calls;
    CHECK(hypergolic_nip44_decrypt(key, (hypergolic_nip44_bytes){peer, 32}, (hypergolic_nip44_bytes){encrypted.data, encrypted.length}, &crypto, capture, &decrypted) == HYPERGOLIC_NIP44_AUTH_FAILED);
    CHECK(sink_calls == before);
    clear_output(&encrypted); clear_output(&decrypted); hypergolic_signer_destroy(key);
}
int main(void) {
    official_vectors(); faults(); CHECK(allocations_live == 0); CHECK(sink_address == NULL); CHECK(cleanups > 100); CHECK(sink_cleanups > 20);
    printf("HOST NIP44 suite: %u assertions, %u cleanup observations, %u sink cleanups passed\n", assertions, cleanups, sink_cleanups);
    return 0;
}
