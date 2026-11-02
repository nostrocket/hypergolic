# Android published artifact registry core

This owning JVM suite compiles production `PublishedArtifactRegistry.java` directly.
It proves strict UTF-8 input, real SHA-256 and NIP-5A aggregate validation, exact
2 MiB acceptance and over-limit denial, private input/output copies, opaque handles,
exact claims, cross-session denial, one-use concurrent claims, consume-on-mismatch, canonical UUID view generations,
host-compatible session IDs, four-entry bounds, expiry, session revocation and
explicit session re-registration. A successful claim
transfers one private byte copy to the native host through `takeHtmlBytes()` and binds it
to a canonical lowercase UUID view generation. The host must clear that returned buffer when its
view is destroyed; the registry can revoke only bytes still staged inside it. `revokeAll()` clears pending handles
and active registrations so a trusted caller must register live sessions again.

This core does not validate a Nostr signature or publisher trust, nor does it prove
Expo bridge ownership, WebView transfer, host-generation integration or device
behavior. The generated host remains unchanged and does not execute published HTML.

```sh
# Configure the pinned tools described in docs/development.md.
python3 tests/native/android-published-artifact-registry/runner.py \
  --output /private/tmp/hypergolic-android-published-artifact-registry
```

Use a new output directory. The runner compiles the production class and proof with
`javac -Xlint:all -Werror`, hashes owning inputs before and after, and retains logs
and a JSON receipt.
