# Native Mesh TLS proof

Run with an existing CMake/Clang toolchain; nothing is installed:

```sh
python3 tests/native/mesh-tls/run.py --output /private/tmp/mesh-tls-proof
```

Optional existing cross-toolchains:

```sh
python3 tests/native/mesh-tls/run.py --output /private/tmp/mesh-tls-all \
  --android-ndk /path/to/installed/ndk --iphoneos
```

The runner refuses an existing/in-source output directory, hashes source before
and after, and records actual archives, logs, host and ASan/UBSan results.
Cross-compiles produce static ARM64 objects only: no Gradle, app signing,
installation, devices, network, pairing or user-vault access. Pruned vendoring
is built cleanly through actual upstream CMake groups and library guards.

The proof includes the real wrapper implementation to inspect native-only key
retirement and inject hostile peers without product bypass switches. It drives
actual client/server TLS over bounded in-memory BIO queues. Controls cover valid
mutual pins and encrypted payload, secure-store DER roundtrip, wrong pins both
ways, missing client certificate, expired/future validity, usage policy, extra
issued chain, corrupt self-signature, unsupported certificate algorithm, partial
I/O, original deadline and byte budget, revocation/cancel, entropy failure,
rejected storage, mismatched keys, and key retention until session drain.

The SHA384 reference certificate is independently valid under a known nonsecret
P256 scalar1 test key. SHA256 under that same key is a positive handshake control.
Import refuses SHA384; a deliberately hostile test peer substitutes its valid
SHA384 certificate on the wire to exercise actual peer parsing. No generated
reference key is a real device/user identity. Mutating the OID separately tests
malformed peer data; it is not mislabeled as a valid reference certificate.

Blocked-write controls require exact matching native-owned retries. Different
bytes/length fail closed without further BIO output. Read/handshake cannot flush
pending output; completion/cancel erase it. Partial ciphertext may already have
been delivered: closing is not a no-delivery acknowledgement. Original source
permit retention and socket drain are still native coordinator responsibilities.

Tracked allocation peak measures wrapper plus upstream dynamic memory in this
host fixture, excluding in-memory BIO queue/test storage and OS sockets. Zero
tracked bytes after explicit proof shutdown is checked. Archive byte sizes are
not final application size or physical device RAM. These host checks establish
no ordinary Android/iOS Mesh workflow, platform secure storage or paired-device
acceptance.
