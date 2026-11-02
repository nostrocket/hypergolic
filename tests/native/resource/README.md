# Resource native verification

## Host proofs

After activating the pinned Java and iOS toolchains, run `python3 tests/native/resource/run.py`. It compiles owning Java/Swift source with warnings as errors. Java tests native lease borrowing, bounded chunks, token/cursor/replay/cancel/quota/generation/expiry and separate resource/published size/header profiles. Swift tests lease borrowing and independent resource/published body, redirect and repeated-header profiles. These controlled-byte proofs do not instantiate a WebView or prove live transport/playback.

The Android published-HTTPS TLS proof additionally exercises the resource redirect path with controlled public-address DNS and a real TLS fixture. iOS published-HTTPS TLS regression preserves its ordinary production transport behavior. Neither controlled resolver is public-network evidence.

## Actual isolated products

`tests/native/resource/index.tsx` runs real SDK/Kehto/WebView, production broker, native HTTPS/relay and production SQLite download settings with a public-only fixture identity. Use this temporary entry and application identifier `org.nostrocket.hypergolic.resourcefixture` for isolated Release products; restore the normal entry after packaging. Do not publish or use protected identity/signing in this fixture.

The Android driver checks that the installed APK matches the supplied product and records source fingerprints before/after, native input, accessibility XML and screenshots:

```sh
python3 tests/native/resource/android-resource.py --serial DEVICE \
  --apk RESOURCE_APK --sample IMAGE_REFERENCE_JSON --media VIDEO_REFERENCE_JSON \
  --schemes SCHEME_REFERENCES_JSON --audio AUDIO_REFERENCE_JSON --diagnostics \
  --output FRESH_RESULT_DIRECTORY
```

Reference JSON contains independently retrieved public URL, byte count, SHA-256 and MIME. Scheme references include expected image/Blossom/Nostr/data and bulk hashes. The reference downloader is separate from the guest/native resolver. Final reports name the actual native/runtime/fixture/product bytes; successful compilation alone is not a journey.

Run `ResourceTests` in the existing iOS XCTest project against the installed isolated product. It attaches screenshots and JSON reports for image, MP4 playback/lifetime, audio-only MP3 playback, schemes/settings and diagnostics. Export xcresult attachments and seal the installed app bundle independently. Inspect meaningful screenshots rather than marking them visually reviewed automatically.

## Controlled lifetime diagnostics

The visible Resource diagnostics route has seven cases: cancel, owner-epoch revocation, close, background, and cancellation/owner revocation/close before a private chunk is claimed. SDK Cancel is native input; private chunk holds happen before native `take`, so the production registry/broker preserve their actual admission checks. Resolve late controlled bytes only after cancellation/revocation. Require zero late private byte delivery/SDK attachment and no cancel ACK. Multiple identical SDK cancel messages are allowed because cancel is idempotent.

These cases use a held resolver/dispatch with actual SDK, native renderer, native leases, production resource service and carrier. They do not claim live DNS/TLS, actual protected identity switching or renderer-crash coverage. Ordinary runtime-owner tests separately cover identity teardown; final device acceptance remains CAP-14.

The live journey checks public HTTPS exact image, info, private literal/DNS denial, close/reopen/cold launch, complete MP4 over the ordinary JSON ceiling, time advancement, switch/background pause with retained position, manual Play, actual default Blossom redirect/hash, memory retention/revocation, settings persistence, verified one-hop Nostr JSON, trusted data, ordered bulk errors, and audio-only playback. Private artifacts retain receipts and packaging; no fixture publisher event is created.
