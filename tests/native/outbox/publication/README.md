# Native Outbox publication core proof

Configure the pinned Android and iOS tools from `docs/development.md`, then run `python3 tests/native/outbox/publication/run.py --output <fresh-external-directory>`.

The runner compiles the actual Android module and exercises its immutable Kotlin plan on the host JVM. It compiles the actual Swift plan, approval registry and WSS publication owner with Swift 6 and warnings as errors. The Swift composition stub supplies only the static capability lease instance; assertions use the actual native lease and approval cores. Signed fixture inputs are public deterministic test events; no secret key is retained or event published.

Coverage includes event/identity/hash mutation, reviewed targets, one-use primary/ancillary relay pairs, signature consistency across targets, denied unprepared review, replay, and native background/revocation before frame emission. Receipts seal source and logs. This is native core and compilation evidence, not a device journey, public DNS/TLS publication or protected signing acceptance.


The companion `tls_run.py --output <fresh-external-directory>` uses disposable loopback TLS endpoints through the existing host-only policy seams. Both actual native plan/approval gates and WSS EVENT writers are exercised, with exact public signed fixture bytes independently checked by the relay. Nineteen cases per platform cover accepted/rejected ACKs, accepted followed by closure, no ACK, foreign ID, malformed boolean, revocation at final emission, trailing data/NUL, concatenated messages and ASCII/multibyte reason overflow. This does not prove public DNS, guest admission, Android protected signing or physical-iPhone signing. Private TLS keys are deleted after the run.

The existing native WSS writers allow an 8192-byte text frame. Shared request capture and both native review captures enforce the complete signed EVENT size before review/signing, including signature overhead, UTF-8 and escaping. An oversized existing relay list blocks review rather than being silently omitted.

`review.tsx`, `../android-review.py` and `../ios-review.py` exercise the production approval/receipt components with native inputs and sealed products. The fixture explicitly says presentation only, owns no signer and performs no publication. Keep this evidence separate from the required original SDK/native/protected-signing journey.

`owning_tls_run.py --output <fresh-external-directory>` exercises the actual Swift
publication owner through the same approval registry, final send gate, receipt
classifier and WSS writer. Twenty-seven controlled host cases include AUTH, task
cancellation, post-frame revocation, slow/flooded replies and size faults. A
separate concurrent case verifies four active sends, capacity/replay denial and
recovery. Independent receivers check exact EVENTs and zero frames for approval
or task cancellation immediately before send.

The `HYPERGOLIC_NETWORK_PROOF` compilation condition enables only the test route,
public certificate anchor and pre-send revocation hook. Ordinary builds omit that
condition and retain the public relay policy. This test uses an already signed
public fixture; it does not exercise protected signing, guest admission, Expo
composition, physical devices or public DNS. Physical owner evidence is recorded
separately in the Phase 2.11 checkpoint.


The native core proof checks 4,096-byte reasons with ASCII and four-byte Unicode,
empty rejection reasons, missing/extra/null fields, depth thirteen, the exact
2 MiB envelope boundary and an over-limit byte, trailing text/NUL and concatenated
messages. Android uses the compiled module on the host JVM with the documented
org.json test dependency; Swift uses Foundation on macOS. These are host proofs,
not actual Android platform-parser or physical-device parity. Android's original
trailing-text failure is retained before its end-of-message correction. The parser
rejects raw NUL rather than confusing it with JSONTokener's end sentinel. Valid
first ACKs still survive later bad/contradictory responses. This is selected fault
coverage, not exhaustive strict-JSON or complete native fault acceptance.


## Android publication owner against a controlled relay

Run `python3 tests/native/outbox/publication/android_owning_tls_run.py --output <fresh-external-directory>` after sourcing the local Android/iOS tool environments. The runner compiles the actual Release module offline, then executes its unchanged compiled Outbox publication owner, plan, approval registry and acknowledgement classes on the host JVM.

Twenty single-publication cases cover accepted/rejected/missing/foreign/malformed/AUTH replies, valid acknowledgement followed by closure, pre-send approval and job cancellation, post-send approval and job cancellation, trailing payload faults, reason overflow, silent timeout, slow keepalive notices, notice flood and an oversized declared frame. An independent TLS receiver checks the exact public signed EVENT. Both pre-send cancellation cases emit zero EVENT frames; every other case emits one. Silent timeout takes about three seconds, and keepalive notices do not extend the ten-second total deadline.

A separate concurrent case holds four publications open. The fifth reviewed pair returns `cancelled-before-send` with a capacity reason before calling transport; replay of that consumed pair is denied. After the four responses complete, a fresh reviewed target succeeds. The receiver observes exactly five EVENT frames: four admitted publications and the later recovery. All cases verify that the four native semaphore permits are restored and the owner's scheduled deadline queue is empty.

The host composition has three explicit adapters:

- `SystemClock` uses `System.nanoTime`; this does not model Android suspend.
- `Handler`/`Looper` only permit initialization; any attempted UI queue or timer use fails the proof.
- An isolated copy of `PublishedRelayWssQuery.java` changes only the `publish` entry to the controlled route. The runner requires an exact single wrapper match and retains the full patch. Its downstream DNS/TLS/handshake/frame implementation remains unchanged; ordinary production source is not edited.

Receipts bind all 73 selected source/configuration inputs, 388 compiled native class inputs, two cached dependency JARs, the route patch, generated proof classes and original logs. The host uses org.json 20180813 rather than the Android platform parser. Disposable TLS private keys are removed even after a failed run. The original harness compilation error is retained separately.

This proof adds host owner fault evidence. Protected signing, ordinary guest/Expo composition, public DNS policy, Android UI delivery, physical lifecycle/backpressure and complete cross-platform acceptance remain open. No physical matrix row closes, production app is rebuilt or installed, or numeric external quality gate passes because of it.


## Physical Android framework parser and plan proof

Run `python3 -B tests/native/outbox/publication/device_plan_run.py --serial <connected-api36-device> --output <fresh-external-directory>` after sourcing the local tool environments. The runner compiles the actual Release module, packages its class outputs and Kotlin standard library with the existing `PlanProof.java`, then starts a disposable `app_process` under shell UID 2000. It performs no app installation, UI input, protected identity operation or publication.

On the physical API36 phone, all 69 existing plan/ACK assertions pass. This includes the raw-NUL/trailing/concatenated-message faults, exact/over-limit UTF-8 reasons, JSON depth/size limits, exact event/identity/hash/destination capture, one-use pairs and approval revocation. JSONObject, JSONArray and JSONTokener must use the same boot loader as String. The final DEX inventory contains no packaged org.json definitions, so these checks use the Android framework parser rather than the host test JAR.

The source/configuration and 388 compiled module class inputs, Android API JAR, Kotlin dependency, DEX/test JAR and exact public fixture are sealed. Both staged remote files must match their hashes before execution and removal; cleanup verifies their absence plus unchanged third-party package inventory and retained APK path/hash. The first proof's inventory regex had excess escaping. The corrected regex is checked against actual DEX output and an injected org.json class-definition line before the final device run is accepted; both original results remain retained.

This is physical execution of standalone native primitives under shell UID. It does not prove the ordinary installed app includes the latest code, app-UID/Expo/guest composition, protected signing, system authentication, view lifecycle, public TLS sending or complete native fault acceptance. The existing approval proof supplies its own monotonic clock; Android suspend behavior remains open. OB-05 gains this explicit partial subset; no complete requirement closes.


## Swift owner cancellation, bounded replies and capacity

The expanded owning suite compiles actual Swift native sources with Swift6 and warnings as errors, using only the existing `HYPERGOLIC_NETWORK_PROOF` route/anchor/before-send hook. `OwnerProofSupport.swift` supplies the same host capability-registry composition and starts each task only after its cancellation handle is installed. It does not replace the production clock, approval, plan, owner, receipt classifier or WSS implementation.

All twenty single cases pass. Task cancellation in the existing before-send callback emits zero EVENTs. For post-send approval revocation and task cancellation, the independent receiver first verifies the exact EVENT, writes a readiness marker and keeps the connection open without an ACK. The owning task then revokes/cancels, returns unknown and closes the peer; both outcomes occur well before the transport deadline. Silent and keepalive-only peers both stop at about ten seconds on Swift; Android's separate idle-read timeout is not assumed here. Sixty-five notices and a declared frame over2MiB also yield bounded unknown receipts.

The concurrent case withholds four ACKs until four exact EVENTs are observed. The fifth reviewed pair gets a capacity denial; its replay throws the native replay error. Releasing four replies permits a fresh sixth pair. The receiver observes five exact EVENTs and refuses any extra TCP connection. Reflection checks the actual owner counter only after tasks settle; all single and concurrent cases return it to zero. This checks capacity restoration, not timer/connection lifetime or general memory-leak acceptance.

Twenty-six source inputs, two compiled test binaries and all original receiver/log outputs are hash-bound. The disposable TLS key is deleted. No ordinary app rebuild/install, protected signer, guest/Expo, public DNS, physical iPhone or OS-lifecycle claim follows. Both retained native products remain unchanged, and no physical requirement becomes complete from this host subset.


## Current strict Android ACK syntax coverage

`OutboxResponseJson` checks bounded relay-array JSON grammar before Android's
lenient object parser. Current host cores pass 106 Android / 97 Swift assertions;
physical API 36 framework JSON repeats all 106 Android assertions under shell UID
2000. Add `--ack-grammar` to `device_plan_run.py` for the focused 37 assertions.
The runtime record includes the probe PID; only that PID's AndroidRuntime crash
log is captured on failure. Exact staged files are removed and keeper/inventory
are verified unchanged.

The baseline host captures four non-JSON forms, and physical framework JSON
reproduces single-quoted ACK acceptance. The owned crash log proves an expected-
denial assertion followed by Android Runtime process termination; exit 137 alone
was insufficient. A checked-exception wrapper compile failure is distinct.
Fifteen malformed cases now deny capture; escaped rejection reasons, JSON
whitespace and valid nested other-message syntax retain their expected behavior.
The current TLS suite passes 38 cases and each owner suite passes 27 plus capacity
recovery, including seven malformed wire replies. Original older counts above
refer to their earlier checkpoints. This is selected syntax coverage, not an
exhaustive grammar or full native/physical acceptance claim.


## Physical Android owner/WSS faults and capacity

Run `python3 -B tests/native/outbox/publication/device_owning_tls_run.py --serial <connected-api36-device> --output <fresh-external-directory>` after sourcing the checkout toolchain. The runner compiles the actual Release module offline, compiles the existing owner/route/capacity proof against Android's API JAR with all warnings as errors, and packages a temporary DEX JAR. It does not install or update the ordinary app.

`DeviceOwnerTLSProof` requires physical API36, shell UID2000, and boot-loader JSON,
SystemClock, Handler and Looper classes. The public main-Looper bootstrap uses
reflection because the SDK marks the standalone-VM initialization API deprecated;
no hidden API or framework stub is used, and no UI queue is driven. The production
clock, owner, approval registry, plan and downstream WSS code execute unchanged.
Only the exact single publish-route wrapper is adapted; its full patch is retained.
The controlled loopback address/DNS policy and disposable certificate anchor are
explicit test inputs. These do not prove ordinary public relay policy or app UID.

All27 single cases and the capacity/recovery case pass on the physical phone. The
independent receiver observes zero EVENTs for both pre-send cancellations, one for
every other single case, and five for four admitted concurrent sends plus a fresh
recovery. The fifth consumed pair cannot emit or replay. Actual clock deadlines
stop silent/keepalive-only peers, and malformed/flood/oversized replies stay bounded.
Every case restores semaphore capacity and removes its deadline task.

The runner verifies public fixture signatures, source/class hashes, original
receiver/log data, unchanged keeper APK/inventory and pre-existing ADB mappings.
Owned remote files and mappings are removed by exact hash/mapping guards, and the
host TLS private key is deleted. Three failed preflights are preserved separately.
No ordinary guest/Expo/protected signing, UI/suspend, public DNS, complete fanout,
full native fault or MVP acceptance claim follows from this standalone composition.
