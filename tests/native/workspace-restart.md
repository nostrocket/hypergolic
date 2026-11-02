# Native workspace restart journey

The scenario starts from the three disposable bundled UX fixtures, opens a fourth
through Settings, and checks that the fourth remains selected after restart. It
checks opening order in the overview, closes each fixture through the trusted
warning, and proves that the resulting empty overview survives another restart.
Existing identity data is preserved. No key, napplet saved string, relay or private
application API is read. Source and installed artifact correspondence are recorded.

Enable the checkout's local tools and supply an already-running test device. The
Android debug build also needs Metro connectivity. Evidence directories must be
new and private. The journey intentionally ends with no loaded napplets; it refuses
a different starting inventory instead of resetting stored data.

```sh
python3 -B tests/native/workspace_restart.py --source "$PWD" \
  --serial "$HYPERGOLIC_ANDROID_SERIAL" \
  --expected-apk-sha256 "$HYPERGOLIC_ANDROID_APK_SHA256" \
  --output "$HYPERGOLIC_ANDROID_EVIDENCE" workspace-restart

python3 -B tests/native/ios-driver.py --udid "$HYPERGOLIC_IOS_UDID" \
  --bundle-id "$HYPERGOLIC_IOS_BUNDLE_ID" --repo "$HYPERGOLIC_IOS_SOURCE" \
  --output "$HYPERGOLIC_IOS_EVIDENCE" workspace-restart
```

Use a dedicated test target and disposable loaded fixtures. The iOS checkpoint used
a separately built public-identity fixture with actual SQLite and shared application
source, because the normal Simulator entry correctly requires physical-device key
protection. Its preparation is a private artifact, not a production fallback.
Neither that test nor a debug Android result is complete standalone/physical-device
v1 acceptance. See [the implementation checkpoint](../../docs/workspace-storage.md).
