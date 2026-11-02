# iOS asynchronous operation completion ownership

Compiles eight actual NativeVaultSession methods: remote prepare/start/finish/cancel/refresh and signing decision/finish/cancel. Real Swift Tasks, checked continuations and cancellation flags drive delayed old completion/replacement races. UIKit, native authentication/authority, key ownership, crypto and network/core dispatch are explicit host ports. No relay/device/signature/publication or authority-bypass acceptance follows.

```sh
python3 tests/native/signer-core/operation-completion/run.py --output /tmp/signer-operation-completion
```

The 95 checks cover cancelled-old failure and successful completion against replacement work in both lanes; exact replacement task/timer/panel/source/authority preservation; stale panel/start/dismissal/timer callbacks; metadata/confirmation suspension before candidate creation; current success/cancel/timeout; and preserved kind/token targeted cancellation plus possible-dispatch uncertainty. Public strings and fake keys only. Existing native deadlines are not extended.

Six deferred signing-delivery cases cross possible dispatch with unchanged authority, ownership loss or foreground loss. Each invokes the actual `finishSigning` success path, holds the explicit panel-dismissal callback, installs replacement work, then delivers the old callback. The 48 added checks require unchanged success, `signerUncertain` after possible dispatch, denial before dispatch/local delivery, and preservation of the replacement continuation, task, timer, panel, source and dispatch state. A synchronized ownership port and explicit foreground state supply the loss; no UIKit or real native-authority behavior is substituted as acceptance. A staged negative control that disables only the final delivery guard must fail the four ownership/foreground-loss cases.

The runner extracts the owning method bodies without rewriting them. A tiny call-site adapter supports the original unbound method signatures for red reproduction; it does not alter their behavior. A fresh output is required, unavailable compilation or any failed check is nonpassing. `--session-source` permits an exact staged before/after source. This standalone host check does not change central native suite counts.

Queued task-install ports set the real Task cancellation flag before its first turn. The entry-guard checks do not promise to join already-running core/storage/network work; existing busy failures may persist until it unwinds.
