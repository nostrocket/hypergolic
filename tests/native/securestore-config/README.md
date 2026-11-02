# SecureStore configuration boundary

The pinned `expo-secure-store@57.0.3` patch restricts its native data exports to
`org.nostrocket.hypergolic.napplet-config.v1` and exact lowercase `scope.<64hex>` keys.
Both synchronous get/set and asynchronous get/set/delete use the same native gate.
Authentication, access groups, prompts and unsafe accessibility settings are denied.
The accepted accessibility value is `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (6). Android's
upstream default prompt is one blank space; iOS accepts only an absent prompt.

Android reads only the current prefixed record and its modern unauthenticated AES
alias. Record metadata must contain the exact service and actual Boolean values
`requireAuthentication=false` and `usesKeystoreSuffix=true`. Missing fields,
coerced booleans, hybrid encodings and legacy aliases are rejected. iOS searches
only the exact config `:no-auth` service. Neither platform reads an alternate or
legacy address, cleans up old records, deletes a Keystore alias or migrates data.
A present encrypted record whose wrapping key is missing or invalidated produces an
error; it cannot appear as an empty store and trigger a replacement write. Explicit
delete removes only the addressed configuration record. Android commit
failure and iOS deletion errors are reported instead of successful completion.

This preserves all legacy identity encrypted records and aliases while removing
the generic Expo bridge's authority to read, write or delete them. The patch does
not add ownership isolation to configuration calls: the existing trusted config
broker still owns user/publisher/app/version scoping. Native identity access belongs
to the signer/vault authority. No identity operation can use this configuration API.

The source manifest pins the installed package's upstream Git head, original native
source, unchanged policy dependencies, resulting patched files and patch bytes.
The patch is app-specific and must not be published as a general SecureStore fix.

```sh
# Configure the pinned tools described in docs/development.md.
python3 tests/native/securestore-config/run.py
```

The runner applies the patch in a temporary directory, rejects source drift, checks
the complete native export set and fallback/deletion restrictions, and compiles the
actual patched Java and Swift policies. It exercises negative keys, services,
options and Android record metadata. The production config store also round-trips
through the compiled Android policy with a storage double; legacy test rows remain
unchanged. These are host source/policy/caller checks. They do not prove installed
bridge registration, OS encryption, hardware protection or device restart.

## Integration owned by the application build

The patch is registered in `pnpm.patchedDependencies`:

```json
"expo-secure-store@57.0.3": "patches/expo-secure-store@57.0.3.patch"
```

Preserve existing entries. Force the module to compile from patched source using
`expo.autolinking.buildFromSource` in `package.json`:

```json
["^expo-secure-store$", "^ExpoSecureStore$"]
```

Preserve existing patterns. This project also has an `ios.buildFromSource` list;
append both SecureStore patterns there as well because platform options replace
the root list. Keep its existing `^expo-image$` entry. Android matches Gradle project names with a full regex;
iOS matches the npm package or pod name. This is required even if a current local
Android build already selects source. A precompiled AAR/XCFramework cannot include
the new policy. The installed Expo autolinking 57.0.12 implements these selectors.
After coordinating active build jobs, regenerate the lock and install the patch:

```sh
pnpm install --lockfile-only
pnpm install --frozen-lockfile
python3 tests/native/securestore-config/run.py
# Select full Xcode as described in docs/development.md.
cd ios
pod install
```

Verify autolinking selects `buildFromSource` for both platforms, the generated pod
spec compiles the patched Swift files and Gradle executes the SecureStore source
compilation tasks. Rebuild both products and invoke all five data exports directly:
legacy identity get/set/delete and unsafe options must fail before a storage effect;
accepted configuration must read/write/delete its own record. Use disposable fixture
records and compare legacy record/alias inventories before and after. No retained
legacy identity data needs to be deleted to demonstrate denial.
