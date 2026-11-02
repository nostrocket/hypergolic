# Disposable Android signer

This provider fixture implements the selected Intent-only subset of
[NIP-55](https://github.com/nostr-protocol/nips/blob/a79e21d90fce5465b50ef385dd368bba99ec4a0b/55.md).
It uses the public test scalar 9 through native JNI. Never use its account for real data.
It has no network permission, remembered approval, ContentProvider or web callback.
It is a separate test APK; Hypergolic does not expose an incoming signer service.

Build for an exact disposable client:

```sh
python3 tests/native/signer-core/nip55/build-provider.py \
  --output /tmp/hypergolic-nip55-provider-01 \
  --client-package org.nostrocket.hypergolic.signercore.nip55proof
```

The output directory must be new. The helper builds and signs but never installs.
The fixture targets the API 36 emulator and makes no older-Android claim.
Each build uses a fresh disposable Android certificate. Building a second copy
provides the same-package/different-certificate fixture; replace only this temporary
provider during that test, never a retained app. Compare original and final package
inventories and uninstall all temporary clients/providers after each test batch.

Every accepted request displays a native fault selector and a result button.
The valid result, explicit refusal, non-OK result, null result, wrong ID/package/user,
changed event, bad signature, malformed/unknown extras, large reply and crash modes
exercise different client boundaries. Package faults apply to `get_public_key`;
event faults apply to `sign_event`. A different valid key during connection is a
different candidate, not automatically a malformed response. The pending mode
allows cancellation, background and timeout checks without completing the Activity.

The private `events.jsonl` fixture log contains only public request/result data.
The client proof must independently verify signatures and count effects; a provider
return or successful APK build does not prove client acceptance, publication,
native vault storage, protected hardware or interoperability with Amber.
