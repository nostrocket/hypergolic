# Dependency patches

The package manifests and lockfiles own exact versions and patch hashes. Frozen
installation must preserve them. The resolution policy in `pnpm-workspace.yaml`
requires a seven-day release age and no publisher-trust downgrade, with only its
listed exact-version exceptions. A dependency update must review the installed
consumer graph, affected behavior and packaged notices; changing a version label
or suppressing a finding is not remediation.

The SDK 58 age exceptions admit reviewed Expo releases and their required
platform tooling. Publisher-trust checks and the install-script allowlist remain
enforced.

## Active package patches

| Package | Change and boundary | Owning checks |
| --- | --- | --- |
| `aislop@0.16.0` | [C preprocessor classification](../tools/quality/patches/aislop@0.16.0.patch) stops the trivial-comment scanner from treating C-family `#` directives as Python comments. CLI, API and MCP bundles share the correction; actual comments and all other rules remain active. | `pnpm run test:quality` exercises installed CLI/API scans with C directives and genuine C/JavaScript/Python comment findings. |
| `braces@3.0.3` | [Depth guard](../tools/quality/patches/braces@3.0.3.patch) bounds parsing and AST traversal to 256 levels. Unusually deep patterns throw `RangeError`; callers must handle invalid patterns. The root and quality tool use the same patch. | `pnpm run test:quality` checks both installed consumers, hostile nesting and normal glob behavior. |
| `@expo/config@58.0.12` | [Merge guard](../patches/expo-config-safe-merge-58.patch) extends Expo's own merger to drop `constructor` and `prototype` alongside `__proto__`, and materializes sparse array holes as undefined. The upstream merger replaces the former Fastify substitution. Existing tests retain array concatenation, updates-array deduplication, undefined updates, symbols, plugin order and cloning. | Installed-consumer cases in `pnpm run test:quality`; both native prebuilds. |
| `@expo/metro-config@58.0.22` | [Workspace filter](../patches/expo-metro-workspace-ignores-58.patch) applies the existing directory exclusion to glob results as well as traversal. Node's native glob can return an excluded terminal directory for a narrow pattern. Workspace discovery excludes `node_modules`, `Pods` and `Carthage` for narrow and recursive patterns. | Actual Metro workspace discovery in `pnpm run test:quality`; both exports and native builds. |
| `expo-secure-store@58.0.3` | [Configuration-only native gate](../patches/expo-secure-store@58.0.3.patch) restricts every data export to the exact napplet-config service, keys and options. Identity records and legacy addresses cannot be read, written, deleted or migrated through that bridge. Android also rejects a false confirmation option; iOS rejects missing accessibility and updates only to the fixed device-only accessibility. Both platforms must build this module from source. | [SecureStore boundary](../tests/native/securestore-config/README.md); native bridge tests on both platforms. |
| `@kehto/runtime@0.22.0`, `@kehto/shell@0.20.0` | [Runtime patches](../runtime/patches/) supply the selected native adapter, secure randomness and capability behavior. Configuration replies with an ID are correlated responses; only no-ID values reach subscription listeners. Existing ACL, source and session checks remain required. | `pnpm run runtime:test`; [runtime contracts](../runtime/README.md). |

The SecureStore patch is app-specific. It does not turn the generic configuration
API into an identity owner or establish publisher isolation by itself; the trusted
configuration broker owns that scope. Follow its manifest and full native export
checks when updating it.

Expo Config's upstream merger also deduplicates newly added
`updates.assetPatternsToBeBundled` arrays; the former merge substitution retained
duplicates when that field was absent.

## Scoped overrides

Root overrides pin compatible security or tooling updates for fast-uri,
ip-address, brace-expansion, source-map-js, proxy-addr, compression, shell-quote,
MCP SDK, Hono, Zod, qs, body-parser, Hono's Node server, Fallow, xcode's uuid,
node-forge, minimatch and its optimizer dependency.
The manifests are the version authority. Runtime and lab projects have separate
lockfiles and pins; review all ten installed projects when auditing the repository.

Expo CLI and its certificate library use `node-forge@1.4.3`. This release rejects
small-order Ed25519 public keys and fixes HTTP header parsing and TLS error
handling advisories. Existing RSA DigestInfo and PEM Buffer fixes remain.
`pnpm run test:quality` checks forged and valid signatures, malformed RSA
encodings against OpenSSL, and Expo certificate generation and parsing with
disposable certificates.
[Upstream changelog](https://github.com/digitalbazaar/forge/blob/v1.4.3/CHANGELOG.md).

The Expo 58.0.24 update retains the Config merge and Metro workspace patches on
58.0.12 and 58.0.22. SecureStore 58.0.3 adds SwiftPM packaging; its native bridge
and policy dependencies are byte-identical to 58.0.2. The same patch bytes apply,
with refreshed package integrity and provenance pins. Keep both native builds
and the SecureStore source/policy checks with this update.

The following substitutions cross consumers' declared major ranges and need
their specific compatibility checks:

- Six exact Babel consumers select SemVer 7.8.5 instead of 6.3.1. The empty
  runtime range `<0.0.0` has an intentional intersection difference. Keep the
  actual-consumer and Expo/Metro/Worklets checks; do not generalize the override
  to every SemVer 6 caller.
- Expo Fingerprint and ESLint consumers select minimatch 11.0.2 with the
  nonrecursive matcher 1.0.2. Tests exercise their installed APIs, expansion
  limits, ordinary matching, ignore rules and default CJS/ESM bundles.
  Expo CLI 58.1.20 and Fingerprint 0.21.10 no longer depend on `glob`; its
  override and path-scurry override are retired. The consumer tests now exercise
  Expo's native project discovery and template traversal through their current
  Node glob and tinyglobby implementations, including symlink exclusion.

The tracked scene-lifecycle plugin configures the single iOS scene in the Expo
template. Keep the native source-build settings in `app.json` when updating
Expo or regenerating the CocoaPods project.

Expo CLI 58.1.20 has no direct Zod dependency, so no CLI-specific Zod override
is needed. Its optional `expo-mcp` peer is absent from the installed graph.

## Native codec patches and provenance

iOS builds `expo-image` from source and pins `libwebp` 1.6.0 in `app.json`.
[`withNativeCodecPatches.cjs`](../plugins/withNativeCodecPatches.cjs) pins the
libdav1d wrapper and its submodule, then invokes the CocoaPods
[patch hook](../plugins/native-codec-patches.rb). The
[manifest](../plugins/native-codec-patches.json) identifies wrapper commit
`0143c7ca8cf62ddc844031e1f3a661c99d086432`, dav1d source
`676a864a11af2c0522e1f992e770589543894686` and the released tile-offset correction
`2b475307dc11be9a1c3cc4358102c76a7f386a51`. Full-file before/after hashes gate
both owning files; unknown source changes fail before writes. The Pod version
remains 1.2.0. This narrow backport does not establish complete decoder/CVE
clearance. Native updates require regeneration, compilation, focused malformed
input checks and [notice review](native-dependency-notices.md); a JavaScript
export is insufficient.

## Quality and removal criteria

Final acceptance requires React Doctor and aislop at 100/100 and complete
unsuppressed dependency audits. A clean diagnostic run with a null score is not a
numeric pass. Recheck advisory metadata and run the full gate on the final source;
historical reports cannot establish the current result. Native device acceptance
remains a separate requirement.

Replace a local mitigation when an eligible upstream release covers its behavior.
Verify the archive, installed consumer resolution, original notice bytes, positive
and hostile regressions, affected exports/native builds and full quality reports.
Remove the patch and its override only in the same reviewed update. Preserve
earlier failed results as history; publish a new result for the new source.
