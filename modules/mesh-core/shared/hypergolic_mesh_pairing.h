#ifndef HYPERGOLIC_MESH_PAIRING_H
#define HYPERGOLIC_MESH_PAIRING_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Fixed domain-separated attestation data, captured by the native pairing
 * owner. This encoder does not authorize, sign, hash, pair or persist anything. */
typedef struct {
  /* Captured from this device's native invite/join role, never from a guest. */
  uint8_t signer_role; /* 1 = inviter, 2 = joiner */
  uint8_t invite_id[16], invite_secret_hash[32];
  uint8_t inviter_user[32], joiner_user[32];
  uint8_t inviter_spki_pin[32], joiner_spki_pin[32];
  uint8_t inviter_nonce[32], joiner_nonce[32];
  uint64_t expires_unix_seconds;
} hg_mesh_pairing_transcript;

/* 27-byte domain (including NUL), 1-byte signer role, 16-byte invite,
 * seven 32-byte fields, 8-byte expiry. Each role signs its own fixed 276-byte
 * transcript, so one signature cannot act as both sides of same-account pairing. */
#define HG_MESH_PAIRING_BYTES 276u
int hg_mesh_pairing_encode(const hg_mesh_pairing_transcript *transcript,
                           uint8_t *output, size_t capacity, size_t *written);
#ifdef __cplusplus
}
#endif
#endif
