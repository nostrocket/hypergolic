# JNI callback retention

The Android signer library contributes an exact consumer keep rule for
`NativeTransportCrypto.hmac(byte[], byte[])`. JNI finds this class and static
method by name; Java downcall rules do not preserve that upcall. Removing it
breaks the shared NIP-44 transport used by CVM and outgoing NIP-46. The rule adds
no Expo API, signing authority or new cryptography.

With the pinned JDK and Android SDK configured, run:

```sh
python3 -B tests/native/signer-core/r8-transport/run.py --output /tmp/fresh-r8-transport
```

The runner compiles actual owning Java sources and minifies them twice using R8:
without the library rule the callback must disappear; with it the exact static
method must retain compiled instructions. The same audit requires the exact
`NativeSignerCore$Denied(String)` constructor used by JNI `ThrowNew`. Its fixed
message remains unchanged. The entry calls only native key
transport, with no Java reference to the callback. `TransportProof` uses fresh
ephemeral keys for two local encryption/decryption round trips. Its DEX JARs can
be executed in an explicitly reviewed shell-UID Android harness alongside the
same product JNI library; the runner itself performs no device or network calls.
Without the rules, output must report `round-trips=0` and
`serialization-denied=false`; with them, `round-trips=2` and
`serialization-denied=true`. Both controls require `sink-identity=true`: a
throwing sink must retain its original exception. The serialization denial uses
only a safe zero handle and an in-memory sink. Preserve both controls and exact
JNI hash.
This is not ordinary-app or protected-identity acceptance.

Audit a packaged Release APK separately:

```sh
python3 -B tests/native/signer-core/r8-transport/audit.py \
  --artifact /tmp/actual-release.apk --output /tmp/fresh-callback-audit.json
```

The audit reads class definitions and encoded methods, requiring the exact
class, static `hmac` descriptor `([B[B)[B`, the denial String constructor and
nonempty compiled code for both. A string or
type reference alone cannot pass. An ordinary Release build must also preserve
the library's consumer-rule wiring; this small minification proof does not
replace that build or runtime acceptance.
