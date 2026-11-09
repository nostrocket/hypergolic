#include "hypergolic_mesh_pairing.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned checks;
#define CHECK(x) do { ++checks; if (!(x)) { \
  fprintf(stderr, "pairing check failed at line %d: %s\n", __LINE__, #x); \
  exit(1); } } while (0)

int main(void) {
  hg_mesh_pairing_transcript t;
  memset(&t, 0, sizeof(t));
  t.signer_role = 1;
  for (size_t i=0; i<16; ++i) t.invite_id[i]=(uint8_t)(i+1);
  uint8_t *fields[] = {t.invite_secret_hash, t.inviter_user, t.joiner_user,
    t.inviter_spki_pin, t.joiner_spki_pin, t.inviter_nonce, t.joiner_nonce};
  for (size_t f=0; f<7; ++f)
    for (size_t i=0; i<32; ++i) fields[f][i]=(uint8_t)(f*32+i+1);
  t.expires_unix_seconds = UINT64_C(1794090000);
  uint8_t first[HG_MESH_PAIRING_BYTES], other[HG_MESH_PAIRING_BYTES]; size_t count;
  CHECK(hg_mesh_pairing_encode(&t, first, sizeof(first), &count));
  CHECK(count == sizeof(first));
  t.signer_role = 2;
  CHECK(hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
  CHECK(memcmp(first, other, sizeof(first)) != 0);
  CHECK(first[27] == 1 && other[27] == 2);
  t.signer_role = 0;
  CHECK(!hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
  t.signer_role = 3;
  CHECK(!hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
  t.signer_role = 1;
  /* Every field participates; no transcript field is silently omitted. */
  for (size_t f=0; f<7; ++f) {
    fields[f][1] ^= 1;
    CHECK(hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
    CHECK(memcmp(first, other, sizeof(first)) != 0);
    fields[f][1] ^= 1;
  }
  ++t.expires_unix_seconds;
  CHECK(hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
  CHECK(memcmp(first, other, sizeof(first)) != 0);
  --t.expires_unix_seconds;
  /* A second device may belong to the same account, but not the same pin. */
  uint8_t saved[32]; memcpy(saved, t.joiner_user, 32);
  memcpy(t.joiner_user, t.inviter_user, 32);
  CHECK(hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
  memcpy(t.joiner_user, saved, 32);
  memcpy(saved, t.joiner_spki_pin, 32); memcpy(t.joiner_spki_pin, t.inviter_spki_pin, 32);
  CHECK(!hg_mesh_pairing_encode(&t, other, sizeof(other), &count) && count == 0);
  memcpy(t.joiner_spki_pin, saved, 32);
  memcpy(saved, t.joiner_nonce, 32); memcpy(t.joiner_nonce, t.inviter_nonce, 32);
  CHECK(!hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
  memcpy(t.joiner_nonce, saved, 32);
  for (size_t f=0; f<7; ++f) {
    memcpy(saved, fields[f], 32); memset(fields[f], 0, 32);
    CHECK(!hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
    memcpy(fields[f], saved, 32);
  }
  memset(other, 0x71, sizeof(other));
  CHECK(!hg_mesh_pairing_encode(&t, other, sizeof(other)-1, &count));
  CHECK(other[0] == 0x71 && count == 0);
  CHECK(!hg_mesh_pairing_encode(NULL, other, sizeof(other), &count));
  CHECK(!hg_mesh_pairing_encode(&t, NULL, sizeof(other), &count));
  CHECK(!hg_mesh_pairing_encode(&t, other, sizeof(other), NULL));
  t.expires_unix_seconds = 0;
  CHECK(!hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
  t.expires_unix_seconds = UINT64_MAX;
  CHECK(!hg_mesh_pairing_encode(&t, other, sizeof(other), &count));
  printf("{\"status\":\"passed\",\"assertions\":%u,\"vector\":\"", checks);
  for (size_t i=0; i<sizeof(first); ++i) printf("%02x", first[i]);
  puts("\"}");
  return 0;
}
