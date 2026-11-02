cmake_minimum_required(VERSION 3.22)
project(hypergolic_signer LANGUAGES C)
set(HYPERGOLIC_SECP256K1 "${CMAKE_CURRENT_SOURCE_DIR}/../vendor/secp256k1")
set(HYPERGOLIC_MONOCYPHER "${CMAKE_CURRENT_SOURCE_DIR}/../vendor/monocypher")
add_library(hypergolic_signer STATIC
  hypergolic_signer.c
  hypergolic_nip44.c
  ${HYPERGOLIC_MONOCYPHER}/src/monocypher.c
  ${HYPERGOLIC_SECP256K1}/src/secp256k1.c
  ${HYPERGOLIC_SECP256K1}/src/precomputed_ecmult.c
  ${HYPERGOLIC_SECP256K1}/src/precomputed_ecmult_gen.c
)
target_include_directories(hypergolic_signer PUBLIC include PRIVATE ${HYPERGOLIC_SECP256K1}/include ${HYPERGOLIC_MONOCYPHER}/src)
target_compile_definitions(hypergolic_signer PRIVATE
  ENABLE_MODULE_EXTRAKEYS=1 ENABLE_MODULE_SCHNORRSIG=1 ENABLE_MODULE_ECDH=1
  ECMULT_WINDOW_SIZE=15 COMB_BLOCKS=43 COMB_TEETH=6
  SECP256K1_NO_API_VISIBILITY_ATTRIBUTES=1
)
set_target_properties(hypergolic_signer PROPERTIES
  C_STANDARD 99 C_STANDARD_REQUIRED YES C_EXTENSIONS NO
  C_VISIBILITY_PRESET hidden POSITION_INDEPENDENT_CODE ON
)
