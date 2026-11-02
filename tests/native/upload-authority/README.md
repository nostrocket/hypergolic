# Upload owning proofs

Use the pinned development tools:

- `pnpm run test:uploads:native` compiles actual Java/Swift owners with warnings as errors. Controlled native clocks test body/hash/review matching, one-use signing/dispatch, quotas, focus, background, close/replacement, expiry and clock regression. Credential cases check the exact private event template/hash/scope/time, including wall-clock rollback after capture. These native parsers are not Schnorr verifiers.
- PNG cases check unchanged metadata-free output, CRC/order/color, compressed stream and decoded-size limits, malformed files and exact sanitation of text/time/neutral-orientation Exif metadata. Independent recipes cover compressed text, private fields, malformed offsets/CRCs and unsupported orientation/color/animation; output pixels and supported color chunks must remain byte-identical. iOS also exercises the actual ImageIO decoder. The later native photo preparer adds bounded static JPEG/PNG/WebP/GIF/HEIC, full-image orientation and sRGB/Display P3 preservation; see the selected profile for its separate real picker and codec evidence.
- Attachment cases use independently generated real WAV/MP4/PDF/ZIP/text. They assert exact unchanged review/dispatch bytes, native MIME classification, all WAV/MP4 prefix truncations, video-brand bounds and photo/SVG fallback denial. Signature recognition is not document rendering or playback validation; selected MP3 is not accepted yet.
- Registry cases exercise native-captured registration/header, opaque token versus public ID, foreign-generation denials, one-use take/review/signing/dispatch and sticky post-dispatch uncertainty. Host frame/origin/sequence admission is outside these portable owner checks.
- `pnpm run test:uploads:tls` runs actual Java and Swift raw PUT owners against isolated TLS servers. A separate observer compares exact stored bytes/hash and independently verifies the real disposable Schnorr authorization. Cases cover 200/201, switching, 403/413/429, redirects, lost acknowledgement, pre/post-dispatch cancel, mixed DNS, untrusted certificate and wrong hostname. No public PUT occurs. The mixed-address policy case does not establish public DNS behavior.

Shared `test:uploads` ports are controlled doubles; Chromium/WebKit `runtime` tests use the genuine SDK/Kehto and actual private carrier with controlled native replies. Neither is a native SDK-to-HTTPS/UI acceptance journey.

The [isolated upload entry](../upload/index.tsx) has accepted first-PNG, selected-file, prepared-photo and revoked-picker journeys. Durable recovery, transfer faults and queue bounds have independent native owners and actual app drivers. Normal signed admission now passes both selected native hosts; selected acceptance uses the owner-approved
patched-tooling exception. These fixtures use a disposable identity and compile-gated loopback TLS; protected-device signing and public-provider acceptance remain separate gates. See [the selected upload boundary](../../../docs/upload-access.md).


Recovery ledger proofs compile the actual metadata codec and native read authority.
They cover bounded records, checksum/readback failure, settled-only eviction,
identity/provider/hash duplicate blocking, monotonic deadlines, two read slots and
irreversible background/close/identity revocation. Injected file stores and clocks
are controlled owner tests, not filesystem or app-lifecycle acceptance. Real native
app journeys separately inspect mode-600/mode-700 storage and prove checksum,
unsafe-mode and symlink rejection before review or networking.

`python3 tests/native/upload-authority/recovery_tls_run.py` exercises the actual
Java/Swift raw recovery GET owners against independently observed TLS. Reads carry
no authorization and use only the captured provider/hash. Complete exact 200 and
framed 404 settle presence/current absence; wrong bytes, malformed/truncated
framing, redirects and other statuses leave uncertainty. Controlled authority
revocation in this probe complements actual Home/background app evidence.

The genuine SDK queue fixtures separate eight pending realms from two approved
transfers, deny a second pending request in a realm and deny overflow before
network dispatch. Test-only Android accessibility snapshots run under shell UID
and require newly written native roots; they avoid consuming the sixty-second
transfer lifetime while waiting for UI idleness. The optional emulator TCP hop
limits bandwidth without terminating TLS or parsing HTTP. It is used only to
witness interruption after some, but fewer than all, approved body bytes; queue
checks use direct loopback TLS. Neither test tool is an upload transport double.


The `upload/build.py --entry published` fixture uses the actual IdentityShell,
Settings, verification, SQLite grant/cache, runtime and native upload owners with
a locally supplied signed manifest and a separate public disposable upload key.
`upload/android-published.py` and `upload/ios-published.py` verify normal first-open
reject/accept, advisory info, per-upload reject/approve, exact PNG/WAV storage and
Schnorr signatures, original SDK receipt and persisted cold launch. They require
matching build/current-source/installed-product seals. Only the isolated fixture
exposes public test WAV bytes to the system Files chooser; it retains the same
compile-gated TLS and Simulator protection limits described above.

Android native-app snapshots use the fresh-root shell tool. System DocumentsUI
uses ordinary settled UIAutomator snapshots because fast snapshots can retain
stale picker roots. iOS constrains gestures to the observed guest WebView bounds
and queries full accessibility labels for long consent text. These are actual
native input/navigation journeys. They do not publish the signed fixture or
establish protected-device, public-provider or ordinary identity-switch parity.


The iOS signed first-open method requires a fresh disposable fixture installation
without an existing grant/cache. Preserve previous fixture evidence first, then
remove/install only `org.nostrocket.hypergolic.uploadfixture`; retain the grant for
its in-method cold-restart check. Reinstalling an existing app preserves its
accepted grant and correctly skips repeated first-open consent. The Android
driver explicitly clears its separate fixture package before this method.
