# Native application-data policy checks

Run with the pinned JDK17/Kotlin cache and Xcode toolchains:

```sh
python3 -B tests/native/app-data-policy/run.py --output /absolute/fresh/proof-directory
```

`--cache` can name an existing read-only Maven cache when testing an isolated source
copy. No packages are downloaded. `--checkpoint` optionally verifies a supplied
source-hash manifest before compilation. Output must be a new directory.

The runner compiles the actual Android and Swift policy parsers and canonical JSON
helpers. Android configuration is compiled directly; the exact Swift configuration
definition is extracted without rewriting its body to avoid unrelated transport
dependencies. Android metadata uses the actual WebView projection statements in
a wrapper with inert chunk/claim inputs; iOS metadata uses the production registry
and one-use artifact reader. Source and extracted-fragment hashes are recorded.

Cases cover the known published namespace, release/account stability, different
publisher/napplet isolation, Unicode and escaped source identities, actual
Relay/Outbox grants, absent policy, malformed fields, peer/default/size limits and
the existing8KiB configuration bound. Accepted configurations round-trip their
policy through snapshots and artifact metadata. A request containing inner JSON
with an escaped lone surrogate stays byte-identical and opaque. Separate native
generations preserve distinct snapshots without changing grants.

These checks instantiate no WebView, Expo module, device, signing operation or
socket. They do not prove foreground/revocation enforcement, revision checks,
native effect authorization, provider interoperability or ordinary app acceptance;
those remain separate owning tests and device journeys.
