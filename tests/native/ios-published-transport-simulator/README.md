# iPhone Simulator published transport proof

Run both actual Swift transport owners against disposable loopback TLS servers
inside a booted arm64 iPhone Simulator. The wrapper requires an explicit
Simulator ID, checks the complete HTTPS and WSS case lists, hashes owning
source before and after the run, and writes a JSON receipt to a new directory.

```sh
# Select full Xcode as described in docs/development.md.
python3 tests/native/ios-published-transport-simulator/runner.py \
  --simulator BOOTED_SIMULATOR_UDID --output /private/tmp/hypergolic-ios-transport-proof
```

HTTPS covers six TLS socket cases plus four DNS answer-set checks. WSS covers
eight TLS socket cases. The runners build standalone proof binaries with the
`HYPERGOLIC_NETWORK_PROOF` flag; the normal Expo app does not define that
flag. These checks exercise iOS Simulator's Network.framework and the owning
Swift transports, not the Expo app lifecycle or a physical iPhone. Local
socket permission and OpenSSL are required.
