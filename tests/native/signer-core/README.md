# Native signer suite composition

The central driver runs the existing owning fixture drivers. `all` means all
four defined suites applicable to the selected platform; it does not mean full
Phase 3, ordinary-app, physical-protection or real-signer acceptance.

| Platform | Suite | Owning driver | Required input |
| --- | --- | --- | --- |
| Android | core | `android/run.py` | explicit emulator serial |
| Android | migration | `android/migration.py` | explicit emulator serial |
| Android | nip46 | `nip46/android/run.py` | explicit emulator serial |
| Android | nip55 | `android/migration.py --validator-only`, then `nip55/android/run-controller.py` | explicit emulator serial and reviewed provider build |
| iOS | core | `ios/run.py` | explicit booted Simulator UDID |
| iOS | migration | `ios/run-persistence.py` | explicit booted Simulator UDID |
| iOS | nip46 | `ios/run-nip46.py` | explicit booted Simulator UDID |
| iOS | nip55 | Android-only | not applicable in `all`; requesting it alone fails |

Use the repository's pinned local tools. Coordinate exclusive device ownership
before executing; these drivers install disposable apps and NIP-46 starts a
controlled local peer. No physical device serial, automatic device selection,
provider download or automatic provider preparation is added by the central
driver. The NIP-55 provider must be a separately reviewed build whose allowed
client includes `org.nostrocket.hypergolic.signercore.nip55proof`. Its owning
controller validates source/APK/certificate inputs and uses API 36.

```sh
pnpm run test:signer:native -- --platform android --suite nip55 \
  --serial emulator-5554 --provider /tmp/reviewed-nip55-provider \
  --output /tmp/fresh-signer-nip55
pnpm run test:signer:native -- --platform android --suite all \
  --serial emulator-5554 --provider /tmp/reviewed-nip55-provider \
  --output /tmp/fresh-signer-android-all
pnpm run test:signer:native -- --platform ios --suite all \
  --udid BOOTED_SIMULATOR_UUID --output /tmp/fresh-signer-ios-all
```

Output must be absent. Each child gets its own fresh named subdirectory; the
central `receipt.json` records driver hashes, exit codes, child receipt hashes,
positive relevant counts and separate passed/failed/blocked/not-run/unsupported/
not-applicable totals. Child stdout/stderr stays in the private evidence output.
Android `all` selects five child invocations (NIP-55 has two), while iOS selects
three and explicitly records NIP-55 as not applicable, never as passed.

The complete selection is preflighted before any child starts. Missing device,
provider or driver inputs remain nonpassing. A child failure, missing/negative
receipt, zero count, boolean in place of a count or driver drift stops subsequent
dispatch. Existing failed output is never overwritten. No parent timeout/kill,
device cleanup bypass or new retry is added: each existing driver owns its
execution/reconciliation. A failed or interrupted child still needs its exact
side effects reconciled before a new run; the aggregate failure is not a cleanup
certificate. Host/device doubles and environment limits remain those named in
each owning receipt.

Driver regressions use real disposable Python child processes and fake native
receipts to test orchestration, not native behavior:

```sh
python3 -B tests/native/signer-core/test_runner.py -v
```

Existing bridge, source-hold, handoff, panel-cancellation, launch-admission,
relay-ordering and ordinary-app journeys remain separate owning commands.
Passing this composition does not substitute for those traces, protected-device
authentication/capture checks, real Amber signing, all publication/Outbox/Blossom
routes, controlled receiver outcomes, accessibility or the final quality gates.
