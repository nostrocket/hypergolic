#include "hypergolic_nip44.h"
#include "hypergolic_signer_internal.h"
#include "monocypher.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_RAW ((size_t)5242951)
static void wipe(void *memory, size_t length) {
    crypto_wipe(memory, length);
#ifdef HYPERGOLIC_NIP44_TEST
    extern void nip44_test_cleared(const void *memory, size_t length);
    nip44_test_cleared(memory, length);
#endif
}
static void release(unsigned char *memory, size_t length) {
    if (memory) { wipe(memory, length); free(memory); }
}
/* NIP-44 framing arithmetic, bounded well below size_t overflow on 32-bit hosts. */
static size_t padded_length(size_t length) {
    size_t power = 1, chunk;
    if (length < 1 || length > HYPERGOLIC_NIP44_MAX_PLAINTEXT) return 0;
    if (length <= 32) return 32;
    while (power < length) power *= 2;
    chunk = power <= 256 ? 32 : power / 8;
    return ((length - 1) / chunk + 1) * chunk;
}
static int valid_utf8(const unsigned char *bytes, size_t length) {
    size_t i = 0;
    while (i < length) {
        uint32_t scalar, minimum;
        unsigned int following, j;
        unsigned char first = bytes[i++];
        if (first < 0x80) continue;
        if (first >= 0xc2 && first <= 0xdf) { scalar = first & 0x1f; following = 1; minimum = 0x80; }
        else if (first >= 0xe0 && first <= 0xef) { scalar = first & 0x0f; following = 2; minimum = 0x800; }
        else if (first >= 0xf0 && first <= 0xf4) { scalar = first & 7; following = 3; minimum = 0x10000; }
        else return 0;
        if (length - i < following) return 0;
        for (j = 0; j < following; ++j) {
            unsigned char next = bytes[i++];
            if ((next & 0xc0) != 0x80) return 0;
            scalar = (scalar << 6) | (next & 0x3f);
        }
        if (scalar < minimum || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) return 0;
    }
    return 1;
}
static int hmac(const hypergolic_nip44_crypto *crypto, const unsigned char *key, size_t key_length,
                const unsigned char *message, size_t message_length, unsigned char out32[32]) {
    memset(out32, 0, 32);
    if (crypto->hmac(crypto->hmac_context, key, key_length, message, message_length, out32) == 1) return 1;
    wipe(out32, 32);
    return 0;
}
static int conversation_key(const hypergolic_signer_key *key, const unsigned char peer32[32],
                            const hypergolic_nip44_crypto *crypto, unsigned char out32[32]) {
    unsigned char shared[32] = {0};
    const unsigned char salt[] = "nip44-v2";
    int success = 0;
    memset(out32, 0, 32);
    if (!hypergolic_signer_shared_x(key, peer32, shared)) goto cleanup;
    success = hmac(crypto, salt, sizeof(salt) - 1, shared, sizeof(shared), out32);
cleanup:
    wipe(shared, sizeof(shared));
    return success;
}
static int message_keys(const unsigned char conversation32[32], const unsigned char nonce32[32],
                        const hypergolic_nip44_crypto *crypto, unsigned char keys76[76]) {
    unsigned char block[32] = {0}, input[65] = {0};
    size_t offset = 0, previous_length = 0;
    unsigned int counter;
    int success = 0;
    memset(keys76, 0, 76);
    for (counter = 1; counter <= 3; ++counter) {
        size_t take = 76 - offset;
        if (take > 32) take = 32;
        if (previous_length) memcpy(input, block, previous_length);
        memcpy(input + previous_length, nonce32, 32);
        input[previous_length + 32] = (unsigned char)counter;
        if (!hmac(crypto, conversation32, 32, input, previous_length + 33, block)) goto cleanup;
        memcpy(keys76 + offset, block, take);
        offset += take;
        previous_length = 32;
    }
    success = 1;
cleanup:
    wipe(block, sizeof(block));
    wipe(input, sizeof(input));
    if (!success) wipe(keys76, 76);
    return success;
}
static const unsigned char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static int base64_value(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}
/* Validate canonical RFC-4648 padding and every byte before allocating a decoder. */
static size_t decoded_length(const unsigned char *payload, size_t length) {
    size_t i, padding = 0;
    if (length < 132 || length > HYPERGOLIC_NIP44_MAX_PAYLOAD || length % 4) return 0;
    if (payload[length - 1] == '=') ++padding;
    if (payload[length - 2] == '=') ++padding;
    for (i = 0; i < length - padding; ++i) if (base64_value(payload[i]) < 0) return 0;
    if ((padding == 1 && (base64_value(payload[length - 2]) & 3)) ||
        (padding == 2 && (base64_value(payload[length - 3]) & 15))) return 0;
    return length / 4 * 3 - padding;
}
static void base64_decode(const unsigned char *payload, size_t length, unsigned char *raw, size_t raw_length) {
    size_t i, position = 0;
    for (i = 0; i < length; i += 4) {
        unsigned int a = (unsigned int)base64_value(payload[i]);
        unsigned int b = (unsigned int)base64_value(payload[i + 1]);
        unsigned int c = payload[i + 2] == '=' ? 0 : (unsigned int)base64_value(payload[i + 2]);
        unsigned int d = payload[i + 3] == '=' ? 0 : (unsigned int)base64_value(payload[i + 3]);
        raw[position++] = (unsigned char)((a << 2) | (b >> 4));
        if (position < raw_length) raw[position++] = (unsigned char)((b << 4) | (c >> 2));
        if (position < raw_length) raw[position++] = (unsigned char)((c << 6) | d);
    }
}
static void base64_encode(const unsigned char *raw, size_t length, unsigned char *out) {
    size_t i, position = 0;
    for (i = 0; i < length; i += 3) {
        unsigned int a = raw[i], b = i + 1 < length ? raw[i + 1] : 0, c = i + 2 < length ? raw[i + 2] : 0;
        out[position++] = alphabet[a >> 2];
        out[position++] = alphabet[((a & 3) << 4) | (b >> 4)];
        out[position++] = i + 1 < length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
        out[position++] = i + 2 < length ? alphabet[c & 63] : '=';
    }
}
static hypergolic_nip44_status encrypt_with_conversation(const unsigned char conversation32[32],
    const unsigned char *plaintext, size_t length, const hypergolic_nip44_crypto *crypto,
    hypergolic_nip44_sink sink, void *sink_context) {
    unsigned char keys[76] = {0}, *frame = NULL, *payload = NULL;
    size_t padded = padded_length(length), prefix = length < 65536 ? 2 : 6;
    size_t raw_length = 0, payload_length = 0;
    hypergolic_nip44_status result = HYPERGOLIC_NIP44_INVALID;
    if (!padded || !plaintext || !valid_utf8(plaintext, length)) goto cleanup;
    raw_length = padded + prefix + 65;
    payload_length = ((raw_length + 2) / 3) * 4;
    result = HYPERGOLIC_NIP44_CRYPTO_FAILED;
    frame = (unsigned char *)calloc(1, raw_length);
    if (!frame) goto cleanup;
    frame[0] = 2;
    if (crypto->entropy(crypto->entropy_context, frame + 1, 32) != 1) goto cleanup;
    if (!message_keys(conversation32, frame + 1, crypto, keys)) goto cleanup;
    if (prefix == 2) {
        frame[33] = (unsigned char)(length >> 8); frame[34] = (unsigned char)length;
    } else {
        frame[35] = (unsigned char)(length >> 24); frame[36] = (unsigned char)(length >> 16);
        frame[37] = (unsigned char)(length >> 8); frame[38] = (unsigned char)length;
    }
    memcpy(frame + 33 + prefix, plaintext, length);
    crypto_chacha20_ietf(frame + 33, frame + 33, padded + prefix, keys, keys + 32, 0);
    if (!hmac(crypto, keys + 44, 32, frame + 1, 32 + padded + prefix, frame + raw_length - 32)) goto cleanup;
    payload = (unsigned char *)calloc(1, payload_length);
    if (!payload) goto cleanup;
    base64_encode(frame, raw_length, payload);
    result = sink(sink_context, payload, payload_length) == 1 ? HYPERGOLIC_NIP44_OK : HYPERGOLIC_NIP44_OUTPUT_FAILED;
cleanup:
    wipe(keys, sizeof(keys));
    release(frame, raw_length);
    release(payload, payload_length);
    return result;
}
static hypergolic_nip44_status decrypt_with_conversation(const unsigned char conversation32[32],
    const unsigned char *payload, size_t length, const hypergolic_nip44_crypto *crypto,
    hypergolic_nip44_sink sink, void *sink_context) {
    unsigned char keys[76] = {0}, calculated_mac[32] = {0}, *frame = NULL, *padded;
    size_t raw_length = 0, ciphertext_length, prefix, plaintext_length, i;
    hypergolic_nip44_status result = HYPERGOLIC_NIP44_INVALID;
    if (!length || payload[0] == '#') return HYPERGOLIC_NIP44_UNSUPPORTED_VERSION;
    raw_length = decoded_length(payload, length);
    if (raw_length < 99 || raw_length > MAX_RAW) goto cleanup;
    ciphertext_length = raw_length - 65;
    result = HYPERGOLIC_NIP44_CRYPTO_FAILED;
    frame = (unsigned char *)calloc(1, raw_length);
    if (!frame) goto cleanup;
    base64_decode(payload, length, frame, raw_length);
    if (frame[0] != 2) { result = HYPERGOLIC_NIP44_UNSUPPORTED_VERSION; goto cleanup; }
    if (!message_keys(conversation32, frame + 1, crypto, keys)) goto cleanup;
    if (!hmac(crypto, keys + 44, 32, frame + 1, raw_length - 33, calculated_mac)) goto cleanup;
    if (crypto_verify32(calculated_mac, frame + raw_length - 32)) { result = HYPERGOLIC_NIP44_AUTH_FAILED; goto cleanup; }
    padded = frame + 33;
    crypto_chacha20_ietf(padded, padded, ciphertext_length, keys, keys + 32, 0);
    result = HYPERGOLIC_NIP44_INVALID;
    plaintext_length = ((size_t)padded[0] << 8) | padded[1];
    prefix = 2;
    if (!plaintext_length) {
        if (ciphertext_length < 6) goto cleanup;
        prefix = 6;
        plaintext_length = ((size_t)padded[2] << 24) | ((size_t)padded[3] << 16) | ((size_t)padded[4] << 8) | padded[5];
        if (plaintext_length < 65536) goto cleanup;
    }
    if (plaintext_length < 1 || plaintext_length > HYPERGOLIC_NIP44_MAX_PLAINTEXT ||
        ciphertext_length != prefix + padded_length(plaintext_length)) goto cleanup;
    for (i = prefix + plaintext_length; i < ciphertext_length; ++i) if (padded[i]) goto cleanup;
    if (!valid_utf8(padded + prefix, plaintext_length)) goto cleanup;
    result = sink(sink_context, padded + prefix, plaintext_length) == 1 ? HYPERGOLIC_NIP44_OK : HYPERGOLIC_NIP44_OUTPUT_FAILED;
cleanup:
    wipe(keys, sizeof(keys));
    wipe(calculated_mac, sizeof(calculated_mac));
    release(frame, raw_length);
    return result;
}
hypergolic_nip44_status hypergolic_nip44_encrypt(const hypergolic_signer_key *key,
    hypergolic_nip44_bytes peer_bytes, hypergolic_nip44_bytes input_bytes,
    const hypergolic_nip44_crypto *crypto, hypergolic_nip44_sink sink, void *sink_context) {
    const unsigned char *peer = peer_bytes.data, *plaintext = input_bytes.data;
    size_t peer_length = peer_bytes.length, length = input_bytes.length;
    unsigned char conversation[32] = {0};
    hypergolic_nip44_status result = HYPERGOLIC_NIP44_INVALID;
    if (!key || !peer || peer_length != 32 || !plaintext || !padded_length(length) ||
        !crypto || !crypto->hmac || !crypto->entropy || !sink) goto cleanup;
    result = HYPERGOLIC_NIP44_CRYPTO_FAILED;
    if (!conversation_key(key, peer, crypto, conversation)) goto cleanup;
    result = encrypt_with_conversation(conversation, plaintext, length, crypto, sink, sink_context);
cleanup:
    wipe(conversation, sizeof(conversation));
    return result;
}
hypergolic_nip44_status hypergolic_nip44_decrypt(const hypergolic_signer_key *key,
    hypergolic_nip44_bytes peer_bytes, hypergolic_nip44_bytes input_bytes,
    const hypergolic_nip44_crypto *crypto, hypergolic_nip44_sink sink, void *sink_context) {
    const unsigned char *peer = peer_bytes.data, *payload = input_bytes.data;
    size_t peer_length = peer_bytes.length, length = input_bytes.length;
    unsigned char conversation[32] = {0};
    hypergolic_nip44_status result = HYPERGOLIC_NIP44_INVALID;
    if (!key || !peer || peer_length != 32 || !payload || !crypto || !crypto->hmac || !sink) goto cleanup;
    if (length > HYPERGOLIC_NIP44_MAX_PAYLOAD) goto cleanup;
    if (!length || payload[0] == '#') { result = HYPERGOLIC_NIP44_UNSUPPORTED_VERSION; goto cleanup; }
    /* Full encoding bounds are checked before ECDH or allocation. */
    if (!decoded_length(payload, length)) goto cleanup;
    result = HYPERGOLIC_NIP44_CRYPTO_FAILED;
    if (!conversation_key(key, peer, crypto, conversation)) goto cleanup;
    result = decrypt_with_conversation(conversation, payload, length, crypto, sink, sink_context);
cleanup:
    wipe(conversation, sizeof(conversation));
    return result;
}
#ifdef HYPERGOLIC_NIP44_TEST
/* Intermediate official vectors are reachable only in the host test build. */
size_t nip44_test_padded_length(size_t length) { return padded_length(length); }
int nip44_test_conversation(const hypergolic_signer_key *key, const unsigned char peer[32],
    const hypergolic_nip44_crypto *crypto, unsigned char out[32]) { return conversation_key(key, peer, crypto, out); }
int nip44_test_message_keys(const unsigned char conversation[32], const unsigned char nonce[32],
    const hypergolic_nip44_crypto *crypto, unsigned char out[76]) { return message_keys(conversation, nonce, crypto, out); }
hypergolic_nip44_status nip44_test_encrypt(const unsigned char conversation[32],
    const unsigned char *text, size_t length, const hypergolic_nip44_crypto *crypto,
    hypergolic_nip44_sink sink, void *context) { return encrypt_with_conversation(conversation, text, length, crypto, sink, context); }
hypergolic_nip44_status nip44_test_decrypt(const unsigned char conversation[32],
    const unsigned char *payload, size_t length, const hypergolic_nip44_crypto *crypto,
    hypergolic_nip44_sink sink, void *context) { return decrypt_with_conversation(conversation, payload, length, crypto, sink, context); }
#endif
