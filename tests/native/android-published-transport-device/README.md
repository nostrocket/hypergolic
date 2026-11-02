# Android published transport runtime proof

Run the actual Java HTTPS and WSS transport owners inside a disposable Android
emulator process, against TLS servers bound to that emulator's loopback. The
runner compiles the repository sources to Java 8 bytecode and DEX, generates
short-lived test certificates, runs the current 55 HTTPS and 37 WSS checks, and removes
its temporary emulator files. The earlier API 26 and API 29 receipts cover the
preceding 25-check HTTPS profile and 37-check WSS profile. They do not establish
the expanded HTTPS suite on those API levels. The runner writes a
source- and DEX-bound JSON receipt.

```sh
# Configure the pinned tools described in docs/development.md.
python3 tests/native/android-published-transport-device/runner.py \
  --serial emulator-5554 --output /private/tmp/hypergolic-transport-proof
```

The output directory must be new. The target must be an explicitly named
emulator. The proof runs under Android's shell UID through `app_process`; it
does not install or modify Hypergolic, exercise its Expo bridge or lifecycle,
or use the app's system trust store. Its test-only resolver, trust factory and
hostname verifier permit disposable loopback TLS. Public production entry
points remain unchanged. Physical-device and app-level negative-path
acceptance remain separate.


## Physical Android selected transport cases — 11 October 2026

```sh
# Configure the pinned tools described in docs/development.md.
python3 tests/native/android-published-transport-device/physical_runner.py \
  --serial DEVICE_SERIAL --output /private/tmp/hypergolic-physical-transport
```

The output directory must be new. This driver selects API 36 and requires the
retained `org.nostrocket.hypergolic.emptyacceptance` app to be installed. It
compiles the actual Release module, packages its unmodified compiled classes with
four owning test files and Kotlin's runtime, and runs a disposable shell-UID
process. No app or instrumentation package is installed.

The final physical run passes 115 assertions: 55 HTTPS, 37 WSS and 23 structural
NIP-01 request/response cases. Its receipt binds 67 source/API/runtime inputs and
389 compiled module classes, then verifies they remain unchanged. Runtime metadata
records API 36, UID 2000, PID and AndroidOpenSSL. All five transferred test files
are hash-checked before deletion and verified absent; local private TLS identities
are removed. Installed app bytes and the third-party package inventory match the
pre-run records.

The TLS cases cover vetted-address fallback, certificate and hostname rejection,
mixed DNS denial before connect, redirect handling, bad WebSocket upgrade,
oversized frame rejection and cancellation. The HTTPS resource subset also checks
allowed redirects, loops, unsafe destinations, mixed DNS at a redirect and the
redirect limit. The WSS loopback suite uses synthetic `event`/`eose` stop labels;
the separate 23-case classifier proof checks actual JSON envelopes. Together they
do not demonstrate a complete native SDK query or expected signed event delivery.

All servers listen on device loopback. Test-only resolver, address policy, trust
factory and hostname verifier supply controlled TLS inputs through existing
package-local seams. Certificate-negative cases use Android's default trust
factory, but this suite does not establish ordinary app/system trust behavior for
public hosts. Expo dispatch, capability permissions, subscriptions, real OS
background/identity/close revocation, protected signing and complete physical
fault acceptance remain separate.

The initial physical run completed all three suites but its observer still
expected the historical 25 HTTPS assertions. That failed receipt and original
runner are retained. Source inspection identifies the existing resource-redirect
cases in the current 55-assertion suite; the final driver and emulator observer
now require 55 without changing any owning production or test case.
