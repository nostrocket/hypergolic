# Native identity-switch journey

Use the explicitly isolated test installations. The Android target contains the
actual protected vault; the iOS public-key fixture substitutes only its nonsecret
inventory and proves UI behavior, not protected storage. Neither script accepts a
normal application identifier for this scenario. No existing app is reset or
uninstalled. Builds, package identity, installed bytes and owning source must be
verified separately before running these commands.

`public-test-identity.mjs` derives the universally known disposable scalar-2 key.
It must never represent a real identity or funds. The helper also decodes a public
npub for selecting the original test identity. Android action logs omit all typed
values. iOS's XCTest artifacts can contain the public test value; no user secret is
requested, read or supplied. The scripts never export the generated starting key.

The scenario checks invalid input, one cancelled confirmation retaining all three
live drafts, accepted import restarting all three, duplicate/current import,
saved-identity selection and cold-launch persistence. The iOS variant also checks
counter state and Settings safe-area placement. Evidence directories must be new.
Native snapshots exclude existing application data; static artifact checks and
screenshots have separately stated proof limits.

```sh
python3 -B tests/native/identity_switch.py --source "$PWD" \
  --serial "$HYPERGOLIC_ANDROID_SERIAL" \
  --package org.nostrocket.hypergolic.identityfixture \
  --activity org.nostrocket.hypergolic.dev.MainActivity \
  --expected-apk-sha256 "$HYPERGOLIC_ANDROID_APK_SHA256" \
  --output "$HYPERGOLIC_ANDROID_EVIDENCE" identity-switch

python3 -B tests/native/ios-driver.py --udid "$HYPERGOLIC_IOS_UDID" \
  --bundle-id org.nostrocket.hypergolic.identityuifixture \
  --repo "$HYPERGOLIC_IOS_SOURCE" --output "$HYPERGOLIC_IOS_EVIDENCE" identity-switch
```

Scratch fixture preparation is private and is not a production fallback. These
checks do not prove physical-device key protection, authentication, backup/deletion,
approval, published loading or final v1 readiness. See
[the implementation checkpoint](../../docs/identity-switching.md).
