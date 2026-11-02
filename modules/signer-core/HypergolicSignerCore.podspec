require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
  s.name = 'HypergolicSignerCore'
  s.version = package['version']
  s.summary = 'Native-owned identity vault and signing review'
  s.description = 'Protected native identities, secret entry and exact NIP-01 native review.'
  s.license = { :type => 'MIT' }
  s.author = 'Hypergolic contributors'
  s.homepage = 'https://github.com/nostrocket/hypergolic'
  s.source = { :git => 'https://github.com/nostrocket/hypergolic.git' }
  s.platforms = { :ios => '18.4' }
  s.swift_version = '6.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'HypergolicIdentityOwner'
  s.dependency 'HypergolicIdentityStore'
  s.dependency 'HypergolicNappletHost'
  s.source_files = 'ios/*.swift', 'shared/hypergolic_signer.c', 'shared/hypergolic_nip44.c', 'shared/hypergolic_signer_internal.h',
    'shared/include/hypergolic_signer.h', 'shared/include/hypergolic_nip44.h', 'vendor/monocypher/src/monocypher.c',
    'vendor/secp256k1/src/secp256k1.c', 'vendor/secp256k1/src/precomputed_ecmult.c', 'vendor/secp256k1/src/precomputed_ecmult_gen.c'
  s.public_header_files = 'shared/include/hypergolic_signer.h', 'shared/include/hypergolic_nip44.h'
  s.private_header_files = 'shared/hypergolic_signer_internal.h'
  s.resources = 'vendor/secp256k1/COPYING', 'vendor/monocypher/LICENCE.md'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_CFLAGS' => '$(inherited) -fvisibility=hidden',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/shared/include" "${PODS_TARGET_SRCROOT}/vendor/secp256k1/include" "${PODS_TARGET_SRCROOT}/vendor/monocypher/src"',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) ENABLE_MODULE_SCHNORRSIG=1 ENABLE_MODULE_EXTRAKEYS=1 ENABLE_MODULE_ECDH=1 ECMULT_WINDOW_SIZE=15 COMB_BLOCKS=43 COMB_TEETH=6 SECP256K1_NO_API_VISIBILITY_ATTRIBUTES=1'
  }
end
