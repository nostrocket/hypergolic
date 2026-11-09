# Native Mesh store filesystem proof

`run.py` compiles the Java store against an Android SDK jar and the actual Kotlin
canonical JSON helper, then compiles Swift 6 with warnings as errors. Both proof
programs use a fresh caller-selected output directory and real host filesystem
barriers. The Java host substitutes checked atomic moves, file sync and directory
sync for Android's `Os` calls. The Swift proof uses its POSIX implementation.

```sh
python3 tests/native/mesh-store/run.py \
  --out /tmp/mesh-store-proof-new \
  --jdk "$JAVA_HOME" \
  --android-jar "$ANDROID_HOME/platforms/android-37.0/android.jar" \
  --kotlin-classpath "$KOTLIN_COMPILER_CLASSPATH" \
  --kotlin-stdlib "$KOTLIN_STDLIB_JAR"
```

The compiler classpath must contain the Kotlin JVM compiler and its dependencies.
The output directory must not already exist. Each command has a 90-second bound;
logs and `receipt.json` preserve compilation and execution failures.

Both proofs exercise durable restart, forwarding dedup, ephemeral body exclusion,
exact tag matching, zero backlog limits with live delivery, quotas, blob sharing,
controlled mutation faults, revocation and same-handle lock-wait deadlines. Java
also checks cross-handle concurrent forwarding claims and partial-ledger refusal.
The injected fixture verifier accepts a sentinel signature: these tests do not
establish BIP340 acceptance, coordinator delivery/EOSE ordering, native app
integration or device durability. The owning API contract is [API.md](API.md).
