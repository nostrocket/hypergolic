#include "hypergolic_signer.h"
#include "secp256k1.h"
#include "secp256k1_extrakeys.h"
#include "secp256k1_schnorrsig.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The owning C source is compiled with allocator interposition only in this
 * host test. Inspect its allocation bytes at free without reading freed memory. */
struct allocation { void *pointer; size_t length; };
static struct allocation allocations[8];
static unsigned int cleared_allocations = 0;
static int uncleared_allocation = 0, allocation_failure_countdown = -1;
void *signer_test_calloc(size_t count, size_t size) {
    unsigned int i; void *pointer;
    if (allocation_failure_countdown == 0) return NULL;
    if (allocation_failure_countdown > 0) --allocation_failure_countdown;
    pointer = calloc(count, size);
    if (!pointer) return NULL;
    for (i = 0; i < 8; ++i) if (!allocations[i].pointer) {
        allocations[i].pointer = pointer; allocations[i].length = count * size; return pointer;
    }
    abort();
}
void signer_test_free(void *pointer) {
    unsigned int i; size_t j;
    for (i = 0; i < 8; ++i) if (allocations[i].pointer == pointer) {
        for (j = 0; j < allocations[i].length; ++j) {
            if (((unsigned char *)pointer)[j]) uncleared_allocation = 1;
        }
        ++cleared_allocations; allocations[i].pointer = NULL; free(pointer); return;
    }
    abort();
}
/* The test-only hook inspects bytes after cleanup but before stack lifetime ends.
 * Remembered sink addresses are compared only here, never read after return. */
static const void *serialized_address = NULL;
static unsigned int cleared_serializations = 0, cleared_stack32 = 0;
static int uncleared_temporary = 0;
void signer_test_cleared_memory(const void *memory, size_t length) {
    const unsigned char *bytes = memory;
    size_t i;
    for (i = 0; i < length; ++i) if (bytes[i]) uncleared_temporary = 1;
    if (length == 32) ++cleared_stack32;
    if (memory == serialized_address) {
        if (length != 32) abort();
        ++cleared_serializations;
        serialized_address = NULL;
    }
}
struct sink_state { unsigned char scalar[32]; unsigned int calls; int result; };
static int scalar_sink(void *opaque, const unsigned char *secret, size_t length) {
    struct sink_state *state = opaque;
    if (length != sizeof(state->scalar)) abort();
    ++state->calls;
    memcpy(state->scalar, secret, length);
    serialized_address = secret;
    return state->result;
}
static unsigned int assertions = 0;
#define CHECK(x) do { ++assertions; if (!(x)) { fprintf(stderr, "assertion failed at line %d: %s\n", __LINE__, #x); return 1; } } while (0)
struct entropy_state { unsigned char secret[32], aux[32]; unsigned int call; int fail; int invalid; };
static int vector_entropy(void *opaque, unsigned char *out, size_t length) {
    struct entropy_state *state = opaque;
    unsigned int call = state->call++;
    memset(out, 0x42, state->fail == 3 ? 1 : length);
    if (state->fail) return state->fail == 2 ? 2 : 0;
    if (call >= 1 && length == 32) {
        if (state->invalid) memset(out, state->invalid == 1 ? 0 : 0xff, length);
        else memcpy(out, state->secret, 32);
    }
    if (length == 64) memcpy(out + 32, state->aux, 32);
    return 1;
}
static int unhex(const char *hex, unsigned char *out, size_t length) {
    size_t i; unsigned int value;
    if (strlen(hex) != length * 2) return 0;
    for (i = 0; i < length; ++i) {
        if (sscanf(hex + i * 2, "%2x", &value) != 1) return 0;
        out[i] = (unsigned char)value;
    }
    return 1;
}
static int all_zero(const unsigned char *bytes, size_t length) {
    size_t i; for (i = 0; i < length; ++i) if (bytes[i]) return 0; return 1;
}
int main(int argc, char **argv) {
    FILE *file;
    char line[2048]; unsigned int rows = 0, digest_rows = 0, sign_rows = 0;
    unsigned char public_key[32], message[100], signature[64], actual[64], output_public[32];
    hypergolic_signer_key *key = NULL, *restored = NULL;
    struct sink_state sink = {{0}, 0, 1};
    struct entropy_state state = {{0}, {0}, 0, 0, 0};
    if (argc != 2 || !(file = fopen(argv[1], "r"))) { fprintf(stderr, "official vector file required\n"); return 2; }
    CHECK(fgets(line, sizeof(line), file));
    while (fgets(line, sizeof(line), file)) {
        char *fields[8], *cursor = line; size_t i, msglen; int expected;
        secp256k1_xonly_pubkey parsed;
        fields[0] = cursor;
        for (i = 1; i < 8; ++i) {
            cursor = strchr(cursor, ','); CHECK(cursor != NULL);
            *cursor++ = '\0'; fields[i] = cursor;
        }
        CHECK(unhex(fields[2], public_key, 32));
        msglen = strlen(fields[4]) / 2;
        CHECK(msglen <= sizeof(message)); CHECK(unhex(fields[4], message, msglen));
        CHECK(unhex(fields[5], signature, 64));
        expected = strcmp(fields[6], "TRUE") == 0;
        CHECK((secp256k1_xonly_pubkey_parse(secp256k1_context_static, &parsed, public_key) &&
               secp256k1_schnorrsig_verify(secp256k1_context_static, signature, message, msglen, &parsed)) == expected);
        ++rows;
        if (msglen != 32) continue; /* Production accepts only Nostr digests. */
        ++digest_rows;
        CHECK(hypergolic_signer_verify_digest(public_key, message, signature) == expected);
        if (strlen(fields[1]) == 64) {
            memset(&state, 0, sizeof(state));
            CHECK(unhex(fields[1], state.secret, 32)); CHECK(unhex(fields[3], state.aux, 32));
            CHECK(hypergolic_signer_generate(vector_entropy, &state, &key));
            CHECK(hypergolic_signer_public_key(key, output_public));
            CHECK(memcmp(output_public, public_key, 32) == 0);
            CHECK(hypergolic_signer_sign_digest(key, message, vector_entropy, &state, actual));
            CHECK(memcmp(signature, actual, 64) == 0);
            CHECK(hypergolic_signer_verify_digest(public_key, message, actual));
            message[0] ^= 1; CHECK(!hypergolic_signer_verify_digest(public_key, message, actual)); message[0] ^= 1;
            actual[0] ^= 1; CHECK(!hypergolic_signer_verify_digest(public_key, message, actual));
            hypergolic_signer_destroy(key); key = NULL;
            /* Import and native serialization preserve each exact BIP-340 scalar,
             * public key and signature, without relying on opaque keypair layout. */
            state.call = 0;
            CHECK(hypergolic_signer_import(state.secret, 32, vector_entropy, &state, &key));
            CHECK(state.call == 1);
            CHECK(hypergolic_signer_public_key(key, output_public));
            CHECK(memcmp(output_public, public_key, 32) == 0);
            sink.calls = 0;
            CHECK(hypergolic_signer_serialize(key, scalar_sink, &sink));
            CHECK(sink.calls == 1); CHECK(serialized_address == NULL);
            CHECK(memcmp(sink.scalar, state.secret, 32) == 0);
            CHECK(hypergolic_signer_import(sink.scalar, 32, vector_entropy, &state, &restored));
            CHECK(hypergolic_signer_public_key(restored, output_public));
            CHECK(memcmp(output_public, public_key, 32) == 0);
            CHECK(hypergolic_signer_sign_digest(restored, message, vector_entropy, &state, actual));
            CHECK(memcmp(signature, actual, 64) == 0);
            hypergolic_signer_destroy(restored); restored = NULL;
            hypergolic_signer_destroy(key); key = NULL;
            memset(sink.scalar, 0, sizeof(sink.scalar));
            ++sign_rows;
        }
    }
    fclose(file);
    CHECK(rows == 19); CHECK(digest_rows == 15); CHECK(sign_rows == 4);
    memset(&state, 0, sizeof(state)); state.secret[31] = 3;
    CHECK(hypergolic_signer_generate(vector_entropy, &state, &key));
    memset(message, 0, 32);
    state.fail = 1;
    memset(actual, 0xff, 64);
    CHECK(!hypergolic_signer_sign_digest(key, message, vector_entropy, &state, actual)); CHECK(all_zero(actual, 64));
    CHECK(!hypergolic_signer_sign_digest(key, NULL, vector_entropy, &state, actual)); CHECK(all_zero(actual, 64));
    CHECK(!hypergolic_signer_sign_digest(key, message, NULL, &state, actual)); CHECK(all_zero(actual, 64));
    CHECK(!hypergolic_signer_sign_digest(NULL, message, vector_entropy, &state, actual)); CHECK(all_zero(actual, 64));
    CHECK(!hypergolic_signer_sign_digest(key, message, vector_entropy, &state, NULL));
    memset(output_public, 0xff, 32);
    CHECK(!hypergolic_signer_public_key(NULL, output_public)); CHECK(all_zero(output_public, 32));
    CHECK(!hypergolic_signer_public_key(key, NULL));
    CHECK(!hypergolic_signer_verify_digest(NULL, message, actual));
    CHECK(!hypergolic_signer_verify_digest(public_key, NULL, actual));
    CHECK(!hypergolic_signer_verify_digest(public_key, message, NULL));
    /* Failed entropy does not poison an otherwise valid key. */
    state.fail = 0;
    CHECK(hypergolic_signer_sign_digest(key, message, vector_entropy, &state, actual));
    CHECK(hypergolic_signer_public_key(key, output_public));
    CHECK(hypergolic_signer_verify_digest(output_public, message, actual));
    hypergolic_signer_destroy(key); key = NULL;
    state.call = 0; state.fail = 1;
    CHECK(!hypergolic_signer_generate(vector_entropy, &state, &key)); CHECK(key == NULL);
    CHECK(!hypergolic_signer_generate(NULL, NULL, &key)); CHECK(key == NULL);
    CHECK(!hypergolic_signer_generate(vector_entropy, &state, NULL));
    state.fail = 0; state.invalid = 1; state.call = 0;
    CHECK(!hypergolic_signer_generate(vector_entropy, &state, &key)); CHECK(key == NULL); CHECK(state.call == 129);
    state.invalid = 2; state.call = 0;
    CHECK(!hypergolic_signer_generate(vector_entropy, &state, &key)); CHECK(key == NULL); CHECK(state.call == 129);
    state.invalid = 0; state.call = 0;
    allocation_failure_countdown = 0;
    CHECK(!hypergolic_signer_generate(vector_entropy, &state, &key)); CHECK(key == NULL);
    allocation_failure_countdown = 1;
    CHECK(!hypergolic_signer_generate(vector_entropy, &state, &key)); CHECK(key == NULL);
    allocation_failure_countdown = -1;
    /* Invalid lengths are rejected before reading the input at all: using a
     * one-byte backing buffer makes unexpected reads visible to AddressSanitizer. */
    {
        unsigned char short_input = 3, invalid[32] = {0};
        unsigned int before;
        state.call = 0;
        key = (hypergolic_signer_key *)&state; /* Failure must overwrite the output. */
        CHECK(!hypergolic_signer_import(&short_input, 33, vector_entropy, &state, &key)); CHECK(key == NULL);
        CHECK(!hypergolic_signer_import(&short_input, 31, vector_entropy, &state, &key)); CHECK(key == NULL);
        CHECK(!hypergolic_signer_import(&short_input, 0, vector_entropy, &state, &key)); CHECK(key == NULL);
        CHECK(!hypergolic_signer_import(NULL, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        CHECK(!hypergolic_signer_import(state.secret, 32, NULL, &state, &key)); CHECK(key == NULL);
        CHECK(!hypergolic_signer_import(state.secret, 32, vector_entropy, &state, NULL));
        CHECK(!hypergolic_signer_import(invalid, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        CHECK(unhex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", invalid, 32));
        CHECK(!hypergolic_signer_import(invalid, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        invalid[31] += 1;
        CHECK(!hypergolic_signer_import(invalid, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        memset(invalid, 0xff, 32);
        CHECK(!hypergolic_signer_import(invalid, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        CHECK(state.call == 0);
        /* The largest valid scalar must retain its exact bytes and usable key. */
        CHECK(unhex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140", invalid, 32));
        before = cleared_stack32;
        CHECK(hypergolic_signer_import(invalid, 32, vector_entropy, &state, &key));
        CHECK(cleared_stack32 == before + 2); CHECK(state.call == 1);
        sink.calls = 0; sink.result = 1;
        CHECK(hypergolic_signer_serialize(key, scalar_sink, &sink));
        CHECK(memcmp(sink.scalar, invalid, 32) == 0);
        CHECK(serialized_address == NULL);
        /* Every callback result other than exactly one fails, clears the scalar,
         * and leaves the owning key usable for subsequent signing. */
        sink.result = 0; before = cleared_serializations;
        CHECK(!hypergolic_signer_serialize(key, scalar_sink, &sink));
        CHECK(cleared_serializations == before + 1); CHECK(serialized_address == NULL);
        sink.result = 2; before = cleared_serializations;
        CHECK(!hypergolic_signer_serialize(key, scalar_sink, &sink));
        CHECK(cleared_serializations == before + 1); CHECK(serialized_address == NULL);
        sink.result = -1; before = cleared_serializations;
        CHECK(!hypergolic_signer_serialize(key, scalar_sink, &sink));
        CHECK(cleared_serializations == before + 1); CHECK(serialized_address == NULL);
        before = sink.calls;
        CHECK(!hypergolic_signer_serialize(NULL, scalar_sink, &sink)); CHECK(sink.calls == before);
        CHECK(!hypergolic_signer_serialize(key, NULL, &sink)); CHECK(sink.calls == before);
        CHECK(hypergolic_signer_public_key(key, output_public));
        CHECK(hypergolic_signer_sign_digest(key, message, vector_entropy, &state, actual));
        CHECK(hypergolic_signer_verify_digest(output_public, message, actual));
        hypergolic_signer_destroy(key); key = NULL;
        memset(sink.scalar, 0, sizeof(sink.scalar));
        /* Partial/full entropy writes must be cleared even when the callback fails. */
        state.call = 0; state.fail = 1; before = cleared_stack32;
        CHECK(!hypergolic_signer_import(state.secret, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        CHECK(cleared_stack32 == before + 2); CHECK(state.call == 1);
        state.call = 0; state.fail = 2; before = cleared_stack32;
        CHECK(!hypergolic_signer_import(state.secret, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        CHECK(cleared_stack32 == before + 2); CHECK(state.call == 1);
        state.call = 0; state.fail = 3; before = cleared_stack32;
        CHECK(!hypergolic_signer_import(state.secret, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        CHECK(cleared_stack32 == before + 2); CHECK(state.call == 1);
        state.fail = 0;
        allocation_failure_countdown = 0;
        CHECK(!hypergolic_signer_import(state.secret, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        allocation_failure_countdown = 1;
        CHECK(!hypergolic_signer_import(state.secret, 32, vector_entropy, &state, &key)); CHECK(key == NULL);
        allocation_failure_countdown = -1;
    }
    /* Remote user/peer metadata needs actual point validation, not hex shape. */
    CHECK(hypergolic_signer_public_key_valid(output_public));
    CHECK(!hypergolic_signer_public_key_valid(NULL));
    {
        unsigned char invalid_point[32] = {0};
        CHECK(!hypergolic_signer_public_key_valid(invalid_point));
        memset(invalid_point, 0xff, sizeof(invalid_point));
        CHECK(!hypergolic_signer_public_key_valid(invalid_point));
        CHECK(unhex("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", invalid_point, 32));
        CHECK(!hypergolic_signer_public_key_valid(invalid_point));
    }
    CHECK(!uncleared_temporary); CHECK(cleared_serializations == 8);
    CHECK(!uncleared_allocation); CHECK(cleared_allocations > 10);
    { size_t i; for (i = 0; i < 8; ++i) CHECK(allocations[i].pointer == NULL); }
    hypergolic_signer_destroy(NULL);
    printf("HOST primitive suite: %u assertions passed; %u official vectors, %u digest verification rows, %u exact signing rows\n", assertions, rows, digest_rows, sign_rows);
    return assertions ? 0 : 1;
}
