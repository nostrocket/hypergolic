# Android native signer relay transport proof

Run `python3 tests/native/signer-core/nip46/android/run-transport.py` from the repository.
It uses the repository JDK and Android API 36 jar, or `ANDROID_HOME`, compiles the
actual Java transport with all compiler warnings treated as errors, and runs
real disposable loopback TLS peers. No production DNS, trust-store or clock
setter exists. Temporary certificates, keys and compiled classes are removed.
This host-JVM proof does not establish Android device runtime or NIP-46 RPC
semantics.

`NativeSignerRelay` is an app-only serial send/read connection; `close` may cancel
from another thread. `Control.attach` supplies the raw TCP socket for immediate
lifecycle cancellation. `Control.beforeSend` validates authority and records
possible dispatch, then returns before the blocking write. The transport holds
no caller locks through network I/O. A failed send must not be retried as though
it had not reached the peer.

One `Budget` belongs to the whole approved operation, including all RPC requests
and up to three relay opens. It keeps the original absolute elapsed deadline.
The limits are 8 MiB per raw WebSocket frame and assembled text, 32 MiB aggregate
HTTP upgrade and WebSocket encoded bytes in both directions, 64 completed frames
including continuations and control, and 32 completed texts in both directions.
The byte accounting covers bytes passed through TLS, not TLS record overhead.
Reads reserve capacity before I/O and refund unused capacity after a successful
read; exceptions retain their reservation conservatively. Exhaustion poisons the
shared budget, including delivery of queued messages. Whole decoded reads are
validated and counted before any text delivery or pong. Normal public decoder
and writer entrypoints retain their 66,560-byte and 8,192-byte limits.

Cases cover strict canonical URLs, ordinary caps, extended frame lengths, invalid
UTF-8, masked/binary/oversized frames, close with trailing data, fragmented message
bounds, control and continuation floods, text/frame/wire/deadline/open budgets,
a 6,990,604-byte roundtrip, ping/pong and remote close, denied dispatch, DNS and
HTTP-upgrade cancellation, deadline expiry, blocked read/write cancellation,
untrusted TLS, mixed DNS and production public-address denial.

`NativeSignerRelayFixture.java` is compiled only into the disposable owning test
APK. Its five-argument `open` accepts the fixture certificate DER, builds a pinned
trust store and resolves `relay.example.org` to loopback through the package-only
controlled route. Production TLS endpoint verification, SNI and hostname
verification remain active. The fixture caller must call `shutdown` during its
cleanup. The host runner compiles this helper; actual Android execution belongs
to the native RPC journey.
