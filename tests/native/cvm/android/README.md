# Android CVM native composition checks

This runner compiles the actual host registration/ingress/permit, session actor,
protocol, lifetime, Expo module and WebView glue against the pinned Android and
normal native-module ABI. It runs controlled WSS/codec lifecycle proofs, then the
actual Java envelope with freshly built JNI/C signing and NIP-44 using generated
in-memory test keys. It does not call a provider, vault, device or app installer.

Supply a fresh output, the pinned toolchain checkout and an ABI directory from a
normal matching native build. The ABI directory contains `signer-core-java`,
`signer-core-kotlin`, `napplet-host-java`, `napplet-host-kotlin`,
`identity-owner-java`, `identity-owner-kotlin` and `expo-core.jar`,
`react-android.jar`, `expo-modules-v2-react.jar`. No dependency download is run.

```sh
python3 tests/native/cvm/android/run.py --output /private/tmp/cvm-native-check \
  --abi-dir /private/tmp/matching-native-abi --toolchain-root /path/to/checkout
```

The clock/main-queue and network/codec seams are test-only fixtures. The crypto
proof uses a test Android JsonReader ABI adapter backed by pinned Gson; it is not
Android platform parser or APK acceptance. Source is hashed before/after, and the
output records individual scope and failures. Full platform builds, real native
UI cancellation and an approved provider journey remain separate gates.

Selected behavior is one approved operation per native context, first reviewed
relay only with no uncertain-send replay/failover, at most two actual contexts,
original first-ingress deadline, and close ACK before actual drain. Native
reservations remain held through an uncooperative resolver or unknown key/socket
teardown. A registered source may continue unfocused after exact review; ordinary
signing focus gates are unchanged. Background/source changes invalidate the old
registration nonce, including callbacks already queued through the main thread.
Already admitted progress may finish delivery after normal operation completion,
but never after explicit source/provider close, background, revocation or expiry.
Queued callbacks are bounded to four responses and 64 events; accepted pending
requests plus queued responses remain at most four.

Private carrier consent/control metadata is checked against the original opaque
MCP message. Operation and scalar token mismatches fail closed; escaped surrogate
arguments remain exact. Each queued event carries its exact native request token,
so cancelling one request removes its permission and delivery leases immediately
without cancelling another request to the same provider. The fixtures also check
that cancellation is not reported as successful operation completion.

The Android working core replaces `List.copyOf` with an immutable defensive copy
for the existing API 24 minimum. The separately archived core review remains
historical; this runner binds the actual integrated sources.

V2 native event delivery parses only the private `{provider,message}` carrier and
keeps the already captured public event body opaque. The exact request-token,
source revision and provider checks remain native. Outer and inner limits are
80 KiB and 40 KiB respectively. The tests retain an escaped lone surrogate in the
public event body and deny old public-wire input, wrong providers and extra keys.
