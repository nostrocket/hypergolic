# Dependency notices and provenance

Third-party originals remain with their owning code or packaged notice assets.
The project's MIT license does not replace their terms. Manifests bind originals,
upstream identities, dependency inputs and selected build artifacts. Preserve
their bytes and the checks that package them.

## Notice ownership

| Material | Source and guard |
| --- | --- |
| Trusted Kehto web runtime | `runtime/assets-manifest.json`, runtime build inputs and notices appended to `host.js`; see [runtime attribution](#runtime-attribution). |
| Main React Native JavaScript | Android `modules/napplet-host/android/src/main/assets/notices/` and iOS `modules/napplet-host/ios/Resources/notices/`, with their manifests and shell notices. Guards verify originals, component mappings and dependency metadata. |
| Android Maven archives, prefab owners and bundled codecs | `modules/napplet-host/android/src/main/assets/archive-notices/` and `ArchiveDependencyNotices.cjs`, bound to the selected runtime artifacts. |
| Android C++/NDK and compiler helpers | `cpp-notices/`, `compiler-notices/`, `CppDependencyNotices.cjs` and `CompilerDependencyNotices.cjs` in the Android host module. These cover reviewed libc++/ABI, toolchain/system-header and compiler material. |
| iOS source-built images and SQLite | The host podspec and `NativeDependencyNotices.rb`, with originals under its `Resources/`. Source selection and codec patches are part of the native build. |
| Native signing cryptography | `modules/signer-core/vendor/secp256k1-manifest.json`, `monocypher-manifest.json`, unchanged upstream originals, and signer-module notice assets on both platforms. |

Android's actual `preBuild` tasks run the notice guards and capture selected
runtime/compiler inventories. iOS pod evaluation checks its inputs. Do not replace
those checks with a filename search or edit a manifest merely to make a changed
dependency pass. A package's declared license does not enumerate every component
inside its prebuilt binaries.

## Runtime attribution

The trusted host includes Kehto ACL, firewall, runtime, services and shell,
napplet core, noble curves/hashes and nostr-tools under the exact versions in its
manifest. Installed noble and nostr-tools originals are preserved. Six Kehto/core
package distributions have declaration-based MIT material without a recovered
original copyright/license file. Do not invent an author or present generic
license material as a verified upstream original.

The recorded Kehto source revision is
`f031d5d2264d047cd40e2524bf12b7f68c74caa6`. Its selected source-map contents were
matched to upstream source; that does not reproduce patched compiled packages.
Napplet core's immutable owning source and the missing original attribution remain
unresolved. Final distribution review must reconcile these gaps. Build tools are
included in the shipped inventory only when actual bundle/package evidence shows
their code contributes.

## Checks

From the repository root with the pinned toolchains installed:

```sh
pnpm run test:native-codec-patches
node --test tests/native/codecs/android-notices.cjs tests/native/codecs/archive-notices.cjs tests/native/codecs/cpp-notices.cjs tests/native/codecs/compiler-notices.cjs
pnpm run test:native-webp
pnpm run test:native-dav1d
python3 modules/signer-core/tests/run-host.py
```

The codec integration and notice tests check actual hooks and adversarial changes.
The WebP/dav1d suites additionally need their documented native source/toolchain
inputs. Signer tests verify the vendored file set and hashes before compiling.
These tests do not replace inspecting the final Android and iOS products.

## Final distribution review

For each final artifact, bind the source tree, package locks, native resolution,
compiler/toolchain and product digests. Then:

1. Map linked and embedded code to the actual component inventory, including
   React Native, Hermes, image codecs, compression, SQLite and signing libraries.
2. Reconcile native and JavaScript inventories. Identify third-party components
   inside prebuilt binaries separately from their wrapper package declarations.
3. Inspect both final packages for applicable original licenses and NOTICE
   material, preserving required copyright and attribution.
4. Review unresolved source/attribution gaps and refresh affected manifests after
   any dependency or packaging change. Retain original evidence and report a new
   result for the new product.

BUILD-01 and final app-wide notice acceptance remain open. Historical package
counts and source-map matches establish their own scope, not complete licensing,
security or reproducibility of a new release.
