# Dependency patches

The package manifests and lockfiles own exact versions and patch hashes. Frozen
installation must preserve them. The resolution policy in `pnpm-workspace.yaml`
requires a seven-day release age and no publisher-trust downgrade, with only its
listed exact-version exceptions. A dependency update must review the installed
consumer graph, affected behavior and packaged notices; changing a version label
or suppressing a finding is not remediation.

## Active package patches

| Package | Change and boundary | Owning checks |
| --- | --- | --- |
| `node-forge@1.4.0` | [RSA patch](../patches/node-forge@1.4.0.patch) rejects unconsumed nested DigestAlgorithm children. It is a local mitigation for GHSA-86w9-cpqp-85rv; the installed package remains 1.4.0 and can still be reported by audits. | `pnpm run test:quality` checks malformed signatures, positive forms and actual Expo consumers. |
| `braces@3.0.3` | [Depth guard](../tools/quality/patches/braces@3.0.3.patch) bounds parsing and AST traversal to 256 levels. Unusually deep patterns throw `RangeError`; callers must handle invalid patterns. The root and quality tool use the same patch. | `pnpm run test:quality` checks both installed consumers, hostile nesting and normal glob behavior. |
| `@expo/config@57.0.9` | [Merge replacement](../patches/expo-config-safe-merge.patch) uses `@fastify/deepmerge@3.2.4` with enumerable symbols, removing `deepmerge`. It preserves tested arrays, undefined updates, plugin order and cloning; it drops prototype-related keys and materializes sparse holes as undefined. This is scoped compatibility, not equivalence for every input. | Installed-consumer cases in `pnpm run test:quality`; both native prebuilds. |
| `expo-modules-jsi@57.0.8` | [Swift interface patch](../patches/expo-modules-jsi@57.0.8.patch) extends the existing sanitizer to remove the internal `__ObjC::` extension spelling emitted with Swift 6.4. | Sanitizer regressions in `pnpm run test:quality`; ordinary iPhoneOS compilation. |
| `expo-secure-store@57.0.3` | [Configuration-only native gate](../patches/expo-secure-store@57.0.3.patch) restricts every data export to the exact napplet-config service, keys and options. Identity records and legacy addresses cannot be read, written, deleted or migrated through that bridge. Both platforms must build this module from source. | [SecureStore boundary](../tests/native/securestore-config/README.md); native bridge tests on both platforms. |
| `@kehto/runtime@0.22.0`, `@kehto/shell@0.20.0` | [Runtime patches](../runtime/patches/) supply the selected native adapter, secure randomness and capability behavior. Configuration replies with an ID are correlated responses; only no-ID values reach subscription listeners. Existing ACL, source and session checks remain required. | `pnpm run runtime:test`; [runtime contracts](../runtime/README.md). |

The SecureStore patch is app-specific. It does not turn the generic configuration
API into an identity owner or establish publisher isolation by itself; the trusted
configuration broker owns that scope. Follow its manifest and full native export
checks when updating it.

## Scoped overrides

Root overrides pin compatible security or tooling updates for fast-uri,
ip-address, brace-expansion, source-map-js, proxy-addr, compression, shell-quote,
MCP SDK, Hono, Zod, qs, body-parser, Hono's Node server, Fallow and xcode's uuid.
The manifests are the version authority. Runtime and lab projects have separate
lockfiles and pins; review all ten installed projects when auditing the repository.

Two substitutions cross the consumers' declared major ranges and need their
specific compatibility checks:

- `@expo/cli@57.0.22>zod` selects 4.6.6 for the CLI's actual schemas and MCP
  integration. Diagnostic structures differ from Zod 3, non-JSON Infinity is
  rejected, and one advertised outer schema differs. Runtime stripping and
  strict nested parameters remain required. This does not establish general
  Zod 3 compatibility or introduce resource bounds those schemas do not have.
- Six exact Babel consumers select SemVer 7.8.5 instead of 6.3.1. The empty
  runtime range `<0.0.0` has an intentional intersection difference. Keep the
  actual-consumer and Expo/Metro/Worklets checks; do not generalize the override
  to every SemVer 6 caller.

`expo-build-properties@57.0.22` leaves scene support unspecified so the tracked
scene-lifecycle plugin remains in control. Native generation and CocoaPods must
retain the configured architecture and source-build options.

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
numeric pass. Historical narrow Forge/braces exceptions supported earlier scoped
work; they do not close the current whole-app quality gate. The pinned Forge
finding and final reports still require closeout. Recheck advisory metadata before
describing a finding or upstream fix as current.

Replace a local mitigation when an eligible upstream release covers its behavior.
Verify the archive, installed consumer resolution, original notice bytes, positive
and hostile regressions, affected exports/native builds and full quality reports.
Remove the patch and its override only in the same reviewed update. Preserve
earlier failed results as history; publish a new result for the new source.
