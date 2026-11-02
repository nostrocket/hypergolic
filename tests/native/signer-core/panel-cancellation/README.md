# Native panel cancellation resource contracts

This standalone host regression extracts the actual resource-transfer statements from `NativeImportPanel.kt` and `NativeConnectionPanel.kt`. It checks the signer module's release compile classpath offline and requires its current resolved coroutines1.8.1 artifact. Kotlin2.1.20 compiles the fixture with warnings as errors.

```sh
# Configure the pinned tools described in docs/development.md.
python3 tests/native/signer-core/panel-cancellation/run.py --output /tmp/hypergolic-panel-cancellation-proof
```

Use a fresh output directory. Existing cached build tools and dependency artifacts are required; missing artifacts or a changed resolved version stop the check for review.

The fixture controls real coroutine dispatch with a manual queue. It covers cancellation before resume, cancellation after resume but before dispatch, normal delivery followed by caller close, and nullable outcome for both panel statements. It also removes each cleanup callback as a negative control and requires the intended cancellation contract to fail. A successful run records36 assertions plus two rejected controls, source/dependency hashes and unchanged-input checks.

Resources are close-counter doubles. This does not execute Android dialogs, JNI key destruction, actual secret input, device lifecycle or a complete Phase3 journey. It is not wired into the unimplemented `all` suite and must not be reported as full-phase acceptance.
