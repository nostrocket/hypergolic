#include "hypergolic_mesh_pairing.h"
#include <string.h>

static int nonzero(const uint8_t *bytes, size_t size) {
  uint8_t any = 0;
  for (size_t i = 0; i < size; ++i) any |= bytes[i];
  return any != 0;
}

int hg_mesh_pairing_encode(const hg_mesh_pairing_transcript *t,
                           uint8_t *output, size_t capacity, size_t *written) {
  static const uint8_t domain[] = "hypergolic.mesh.pairing.v1";
  _Static_assert(sizeof(domain) == 27, "Pairing domain changed");
  if (written) *written = 0;
  if (!t || !output || !written || capacity < HG_MESH_PAIRING_BYTES ||
      (t->signer_role != 1 && t->signer_role != 2) ||
      t->expires_unix_seconds == 0 || t->expires_unix_seconds > UINT64_C(253402300799)) return 0;
  const uint8_t *fields[] = {t->invite_secret_hash, t->inviter_user, t->joiner_user,
    t->inviter_spki_pin, t->joiner_spki_pin, t->inviter_nonce, t->joiner_nonce};
  if (!nonzero(t->invite_id, sizeof(t->invite_id))) return 0;
  for (size_t i = 0; i < sizeof(fields)/sizeof(fields[0]); ++i)
    if (!nonzero(fields[i], 32)) return 0;
  if (memcmp(t->inviter_spki_pin, t->joiner_spki_pin, 32) == 0 ||
      memcmp(t->inviter_nonce, t->joiner_nonce, 32) == 0) return 0;
  size_t at = 0;
  memcpy(output+at, domain, sizeof(domain)); at += sizeof(domain);
  output[at++] = t->signer_role;
  memcpy(output+at, t->invite_id, sizeof(t->invite_id)); at += sizeof(t->invite_id);
  for (size_t i = 0; i < sizeof(fields)/sizeof(fields[0]); ++i) {
    memcpy(output+at, fields[i], 32); at += 32;
  }
  for (size_t i = 0; i < 8; ++i)
    output[at++] = (uint8_t)(t->expires_unix_seconds >> (56-8*i));
  *written = at;
  return at == HG_MESH_PAIRING_BYTES;
}
