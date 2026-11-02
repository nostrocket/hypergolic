#ifndef HYPERGOLIC_SIGNER_INTERNAL_H
#define HYPERGOLIC_SIGNER_INTERNAL_H
#include "hypergolic_signer.h"
/* Private C-to-C helper; never include this header in a platform bridge. */
int hypergolic_signer_shared_x(const hypergolic_signer_key *key,
    const unsigned char peer32[32], unsigned char out32[32]);
#endif
