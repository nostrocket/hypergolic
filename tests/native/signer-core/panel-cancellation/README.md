# Native panel cancellation resource contracts

This device-free host regression extracts the actual resource-transfer statements
from `NativeImportPanel.kt` and `NativeConnectionPanel.kt`. An offline report reads
the production signer's `compileReleaseKotlin` compiler classpath and release
compile libraries. It requires the reviewed Kotlin 2.2.10 and coroutines 1.10.2
selection; changed versions stop for review. Compilation retains warnings as errors.

```sh
# Configure the tools and generated Android project in docs/development.md.
# JAVA_HOME, ANDROID_HOME / ANDROID_SDK_ROOT, GRADLE_USER_HOME and PATH are honored.
python3 tests/native/signer-core/panel-cancellation/run.py --output /tmp/hypergolic-panel-cancellation-proof
```

Use a fresh output directory. The normal generated project and cached dependency
artifacts are required. The report requests no app compile or device task, though
Gradle may prepare its included plugin build logic on a fresh checkout. Missing
artifacts fail; the harness does not download or substitute dependencies. Compiler
bootstrap dependencies and the tested coroutine runtime remain separate classpaths.

The fixture controls real coroutine dispatch with a manual queue. It covers
cancellation before resume, cancellation after resume but before dispatch, normal
delivery followed by caller close, and a nullable result for both panel statements.
Each cleanup callback is removed in an individually executed negative control,
which must fail its ownership assertion. A successful run records 36 assertions,
two rejected controls, exact source/dependency hashes and unchanged-input checks.

The three-argument cleanup callback closes the value supplied by coroutines,
retaining ownership if cancellation prevents delivery. See the published
[coroutines 1.10.2 contract](https://github.com/Kotlin/kotlinx.coroutines/blob/1.10.2/kotlinx-coroutines-core/common/src/CancellableContinuation.kt).

Resources are close-counter doubles. This does not execute Android dialogs, JNI
key destruction, real secret entry, device lifecycle or complete Phase 3 journeys.
It is not part of the unimplemented `all` suite or full-phase acceptance.
