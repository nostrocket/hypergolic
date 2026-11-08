# Bounded resource access

Phase 2.3 implements a selected profile of [NAP-RESOURCE PR13 head 8c0645d](https://github.com/napplet/naps/blob/8c0645d32ceb159bc3e8bcec1107a92862b7e86a/naps/NAP-RESOURCE.md). Domain admission does not promise every resource scheme, codec or delivery model.

## Public contract and authority

Guest SDKs call the Kehto injected resource facade. It accepts the SDK 0.27.2 URL-list form and the SDK 0.33.0 single-resource and per-item hint forms. [SDK 0.33.0 Resource wrapper](https://github.com/napplet/web/blob/efd5aa103359f1b150dfbb8870fa23e90fbc5540/packages/sdk/src/config.ts) The pinned Kehto shell/runtime patches route only `resource.info`, `resource.bytes`, `resource.bytesMany` and `resource.cancel` through ACL/firewall admission to the original native recipient.

Requests contain `type` and a bounded opaque `id`. Single-resource requests add `url` and optional `servers`. Batch requests add either an ordered `urls` list of strings or an ordered `requests` list of objects with the single-resource fields. The SDK receives actual complete `Blob` objects and a required `mime` field matching each successful Blob type. Success is the request type plus `.result` and matching ID; failure is the request type plus `.error`, matching ID and canonical error string. Cancel uses the original ID, has no ACK, is idempotent, and the SDK suppresses late results. Individual bulk failures preserve input order and successful siblings. A cancelled root cancels the whole bulk request.

Caller scope, fetch options, cookies, authorization headers, response headers/status, byte ranges, streams and progress are absent. Correlation IDs confer no authority. The native registry captures identity epoch, publisher, app/version, instance, renderer generation and granted domains. The production broker checks that immutable registration, owner lifetime and claimed native lease before work and delivery. Close, identity transition, replacement and renderer loss revoke the old broker, memory cache and pending/private byte handles. Background revokes native in-flight leases before the React Native lifecycle mirror.

Native Resource GETs identify the client with the fixed Hypergolic Resource User-Agent and its public project URL. The header contains no device, account, or napplet identifiers. [Wikimedia Foundation User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)

A resource grant permits any validated public HTTPS hostname. Each connection resolves and checks all addresses, rejects private/mixed results, pins a permitted address, and verifies TLS against the hostname. HTTPS URLs reject credentials, IP literals, local/private aliases, fragments and malformed controls. A Resource grant authorizes these native routes. The [browser boundary](native-contract.md#artifact-and-browser-boundary) has separately documented networking limits. Its inner CSP admits Blob image/media previews only when resource is granted; the trusted CSP remains the leading head policy before all preludes.

## Selected schemes

| Scheme | Behavior |
| --- | --- |
| `https:` | Native bounded HTTPS GET, at most two public HTTPS redirects under the original deadline. Every hop repeats URL, DNS/address and TLS checks. Loop, private destination, mixed DNS, downgrade, credentials and hop overflow fail closed. |
| `blossom:sha256:<hash>`, `blossom:<hash>[.<extension>]` | Fetch by lowercase SHA-256 from configured HTTPS origins and verify the complete bytes. Advisory `servers` and URI `xs` hints move exact matching configured origins earlier in the search. Unmatched hints confer no destination authority. The extension has no effect on the verified MIME type. |
| `nostr:note…`, `nostr:nevent…`, `nostr:naddr…` | One query through the configured shell relays; strictly verify the signed event/filter and return UTF-8 JSON. Do not follow content URLs, relay hints, decrypt or recursively resolve. Kinds 4 and 1059 are denied. This is a selected public-event representation, not generic encrypted-resource support. |
| `data:` | Decode through the trusted broker, then apply the same byte/MIME limits. MIME labels are untrusted. |
| `htree:` | Explicit `unsupported-scheme`; revisit after Phase 4. |

New download settings seed `https://blossom.primal.net`, `https://cdn.satellite.earth` and `https://blssm.us`, in that order. The same list is selected by the explicit **Restore download defaults** action in trusted Settings. Every saved schema1 list is preserved, including the original two defaults, custom orders and an empty disabled list; there is no automatic migration. Up to four distinct public HTTPS origins are saved in the dedicated native SQLite settings database. These public device settings apply across identities and persist after restart. They do not select an upload provider. Unavailable settings disable Blossom without blocking identity startup or other resource schemes.

The hash-and-extension form follows the bare [BUD-10 URI at b5bd280](https://github.com/hzrd149/blossom/blob/b5bd2801d1763aa635fc8fea7a76597e0eb18990/buds/10.md). The deployed bare-hash form also works. Each request target accepts up to 16 explicit server hints and up to 16 URI `xs` hints within the 8 KiB URL limit. Each hint is limited to 512 UTF-8 bytes. URI hints accept a bare hostname or an HTTPS origin after query decoding. Origin syntax excludes credentials, encoded hosts, paths beyond the root, queries and fragments. Unusable URI hints are ignored, and `as` and `sz` do not affect resolution. The search still attempts at most four configured HTTPS origins. The first two defaults follow the [BUD-01 examples pinned at b5bd280](https://github.com/hzrd149/blossom/blob/b5bd2801d1763aa635fc8fea7a76597e0eb18990/buds/01.md); the additional mirror is an explicit host default, not automatic adoption of publisher hints. Unhinted requests use the configured order; matching hints may still prefer an already configured origin. Actual third-position availability and deadlines require fresh native receipts. The bounded redirect profile was selected after a canonical Primal hash URL returned HTTP 302 to public object storage. The original zero-redirect candidate could not complete that real download. Published HTML retrieval uses a separate 20 MiB profile and verifies the signed artifact hash.

Resource response headers never reach guests. Repeated informational headers, such as the two `x-goog-hash` values observed on the audio sample, are ignored; repeated framing, encoding, redirect or connection fields remain denied. Header/body framing bounds remain independent. Compression is not supported. This follows the need to avoid ambiguous message framing while allowing irrelevant repeated metadata; see [HTTP field semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.2).

## Engineering bounds

| Bound | Selected value |
| --- | --- |
| Complete file / successful bulk aggregate | 10 MiB |
| URLs per bulk call / explicit hints per resource / URI `xs` hints per resource | 8 / 16 / 16 |
| URL / data-URL bytes | 8 KiB / 64 KiB |
| Concurrent retrievals per realm / process | 2 / 4 |
| Waiting retrieval targets per realm / process | 6 / 16 |
| URL attempts per realm per minute, including cache hits | 60 |
| Memory cache per realm / process | 30 MiB / 50 MiB |
| Cached entries per realm | 64, exact URL or verified Blossom hash, LRU eviction |
| Cumulative delivered bytes per loaded realm | 50 MiB, monotonic until revocation |
| Root / requested URL deadline, including all Blossom mirrors | 20 seconds / 15 seconds |
| Private carrier chunk / transfer lifetime | 256 KiB / 15 seconds |
| Private staged handles per realm | 8 |
| PNG, GIF, JPEG, WebP header dimensions | nonzero, at most 4096 per axis |

These are bounded implementation candidates tested for this profile, not a user-approved universal prohibition on larger resources. Streaming and large-file delivery remain unresolved separate work. Uncached targets wait in a bounded queue when active retrieval slots are occupied. The runtime still accepts at most four pending Resource calls per realm; each bulk call has two workers. Six waiting targets therefore accommodate that accepted fan-out behind the two active slots. The process queue holds at most sixteen targets. Overflow returns `quota-exceeded`; no native work is started for overflow or cancelled waiting targets. Each realm keeps FIFO order, and eligible realms rotate after each admission. The original 20-second root deadline includes waiting; the 15-second URL deadline starts at admission. Exact request authority, cancellation and the original deadline are checked again before retrieval. A changed Blossom settings snapshot rejects queued Blossom work before fetching. Cancelled resolvers that ignore abort retain their active concurrency reservation until they actually settle; waiting cancellation cannot free an active resolver's slot.

Native retrieval uses small metadata and app-only chunks. A separate host transfer pool binds opaque one-use cursors to the captured realm. The adapter reconstructs and checks the complete bytes/MIME before giving the SDK a Blob. No public resource message can access the private `resource.__chunk` transport. The ordinary 2 MiB JSON message ceiling remains intact.

The runtime waits for an ordinary native slot before posting Resource requests or private chunks when deferred reads occupy the shared lane. It retains the existing four ordinary / twelve deferred limits and deferred flags. Resource waiting is FIFO, bounded to 16 entries / 256 KiB of captured payloads, and consumes the original bridge deadline. The adapter rechecks recipient lifetime and cancellation immediately before posting. Cancelling an operation removes its queued chunks; cancelling an initial request before posting performs no native read. Disposal rejects queued work and clears its timers.

MIME comes from bytes. The profile admits bounded PNG/GIF/JPEG/WebP headers, WAV/MPEG audio, selected MP4/M4A brands, PDF, fatal UTF-8 text, valid JSON, [GLB v2](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout) and [gzip](https://www.rfc-editor.org/rfc/rfc1952.html). GLB uses at most 16 chunks and a valid UTF-8 JSON asset declaration of at most 2 MiB. Gzip headers are bounded to 64 KiB. The runtime delivers both formats as opaque bytes. Guest code owns model decoding and decompression. Active HTML/XML/raw SVG and unknown/malformed bytes fail. Header parsing is not full codec validation. JPEG dimensions follow [T.81 frame headers](https://www.w3.org/Graphics/JPEG/itu-t81.pdf); WebP canvas dimensions follow [RFC 9649](https://www.rfc-editor.org/rfc/rfc9649.html). Codec support and malformed-media behavior require target-platform evidence. SVG needs bounded network-free rasterization and remains a recorded post-Phase-4 gap.

## Map PBF resources

The shared app/runtime byte classifier recognizes two specific core schemas,
without trusting filenames or upstream MIME headers:

- Fontnik Protocol 1 glyphs return `application/x-protobuf`, based on the immutable
  [glyph schema blob](https://api.github.com/repos/mapbox/fontnik/git/blobs/6930b47a2b49aac58ddf98a02d4bd57185a6ee33).
  Stacks need UTF-8 name/range and complete glyph metrics. A range covers 256
  codepoints, aligned to 256, within Unicode. IDs are unique within each stack.
  Nonempty SDF bitmap lengths match the metric size plus the schema's 3 px border;
  dimensions are at most 4096. At most 16 stacks / 256 glyphs per stack are accepted.
- [MVT 2.1 core schema](https://github.com/mapbox/vector-tile-spec/blob/21ff2cbd83c241d0ecdce0c782ecc08a565e713b/2.1/vector_tile.proto)
  returns `application/vnd.mapbox-vector-tile`. Each layer has explicit version 2,
  a unique UTF-8 name and positive extent. Known typed values, feature type,
  required geometry presence, integer framing and attribute dictionary references
  are checked. Both packed/unpacked repeated integers are accepted.

Names are bounded to 1024 UTF-8 bytes, other strings to 64 KiB. There are at most 256
layers, 65,536 parsed fields and 1,000,000 varints per classification (including the
bounded second pass that validates dictionaries). Nested views share the CPU
budget and original bytes; no geometry/bitmap buffer is expanded. Unknown fields,
groups, extensions and unsupported versions fail specific format recognition.
This is a selected core profile, not a general Protobuf MIME fallback.

MVT commands, polygon topology, projection and rendering remain guest decoder
responsibilities. These checks do not establish a valid rendered map or recover
missing public assets. Existing active-document handling, fetch/hash checks,
size/quota/rate/concurrency, cancellation and caller/cache binding are unchanged.
The existing gzip classifier still returns opaque gzip bytes; this change does
not add automatic decompression or trust Content-Encoding.

Validated map PBF framing is recognized before the text-prefix probe: protobuf field and length bytes can decode as whitespace followed by `<`. Unrecognized HTML/XML/SVG still fails the active-document check; a text prefix alone cannot override a complete known binary structure.

## Cache and playback lifetime

Queued targets recheck their session cache after admission and authority/settings
validation. A successful fetch is validated and cached before its concurrency
slot is released, allowing waiting duplicate URLs to reuse complete bytes.
Each read retains its own cancellation and native authority, receives a separate
byte copy, and consumes the existing rate and delivered-byte budgets. In-flight
requests do not share authority or cancellation; failed or aborted fetches cannot
populate this cache.

Cache and Object URLs live only while that napplet realm is loaded. Equivalent Blossom references share verified bytes by hash. Disabling Blossom blocks cached Blossom delivery too. Switching preserves its cache and place; cold launch refetches. Revocation clears the cache and private transfers. SDK URL helpers revoke on release, including revocation before asynchronous readiness; late completion cannot allocate a fresh URL.

Audio/video uses complete grant-scoped Blob bytes. Trusted native focus/background handling pauses playback; the guest prelude rejects inactive/autoplay attempts and requires a fresh trusted gesture to Play. Returning retains position while loaded and waits for manual Play. iOS enables inline playback and disables AirPlay/Picture in Picture. Closing/replacement destroys the player. No background player, direct network media, stream or OS attachment-save workflow is claimed.


## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run `pnpm run test:resources`, `pnpm run typecheck`, `pnpm run test:capabilities`, `pnpm run runtime:test` and the [native resource guide](../tests/native/resource/README.md). Preserve exact reference bytes/digests, complete Blob MIME/length, source/runtime/fixture/artifact seals and actual rendering/playback/input. Cover Blossom/Nostr/settings/cache, cancellation/private handles, DNS/TLS/redirect/size/MIME/flood/quota, account/replacement and live-player close/death on both published and embedded routes. Header recognition is not full codec safety or decode proof.
