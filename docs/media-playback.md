# Foreground Media playback

The finite-video profile implements shell-owned, finite HTTPS MP4 playback for verified published napplets. The separate live-MP3 profile below requires renewed Media access and its own native Play. The owning [NAP-MEDIA proposal](https://github.com/napplet/naps/blob/7806f438530251fce5129f8e6239d6b642278759/naps/NAP-MEDIA.md) is a draft. The `media` grant and support profile are specific to this implementation.

## Access and playback

The first-open or renewed access review shows the signed release and explains Media. Saved grants that already requested Media require a new review when this profile becomes available. Media changes the reviewed support identity only for declarations that request it. Revoke or close the owning session to remove its player. The host validates the immutable published grant, source frame, registration, and renderer generation before admitting a session.

The native card names the requested hostname and shows the download limit before Play. Play authorizes one download for the selected video. The card shows progress and offers Cancel during the transfer. The source may redirect to another validated public HTTPS host. Playback begins after the complete file passes validation. Guest controls apply only to the current session and its advertised capabilities. Explicit native pause, focus loss, or audio interruption requires another trusted Play. Backgrounding or moving focus cancels the transfer. Creating a replacement retires the previous session, and the old transfer keeps its reservation until its writer settles.

The native downloader validates every hop with the existing public DNS, IP and TLS policy. It accepts an HTTP 200 response with a single bounded Content-Length, identity encoding and an exact body followed by connection close. It allows two validated redirects. Both native readers write directly to the owned file in fixed-size chunks. Android opens the staged descriptor for playback. iOS uses a local asset with external references forbidden. The guest receives session state and capabilities. Queue and artwork URLs and playback hints have no network effects. The iframe CSP and Resource API keep their existing policies.

| Bound | Limit |
| --- | --- |
| Response payload and staging | One file up to 256 MiB, with 128 MiB free-space headroom at admission |
| Transfer and validation | 300 seconds total, 10 seconds without transport progress |
| Decoder preparation | 10 seconds |
| Video dimensions | 3840 × 2160 or 2160 × 3840 maximum |
| Playback duration | 60 minutes maximum |
| Native process Media ownership | One foreground session and one transfer reservation |
| Per renderer generation | 64 successful sessions, with retained terminal records in the guest binding |
| Source URL / ignored queue | 8 KiB / 96 entries |
| Storage | Private temporary file. The owner removes it on close, replacement or revocation. The next transfer clears the one owned orphan path. |

The file validator reads small windows and seeks over the media payload. It checks finite self-contained ISO BMFF structure, declared movie duration, and declared dimensions in H.264 sample descriptions. It allows optional MPEG-4 audio sample descriptions and rejects external data references, reference movies, encrypted sample entry types, recognized encryption boxes in traversed containers, and fragmented containers. The owner checks platform-reported duration and dimensions before enabling output and stops on detected oversize. In-band codec changes can allocate decoder resources before the platform reports them. HLS, playlists, streaming, audio-only content, napplet-owned sessions, alternate source schemes, background playback, OS controls, AirPlay, and picture-in-picture are outside this profile. Known unsupported creation returns a correlated result error. Remote artwork is omitted. Metadata updates have no display effect in this profile.

## Finite wire and checks

The SDK accepts `createSession`, `destroySession`, `sendCommand` and `command` for this shell-owned profile. It exposes the latest state and capabilities to late subscribers and retains `onEnded` for the endpoint lifetime. The canonical identifier belongs to the generation that created it. Retirement removes native output and command dispatch before one terminal notification. Stale or foreign replies do not select a destination.

The isolated contract checks use a fake native browser transport and matching Java and Swift file-admission cases. Native sink tests stream synthetic 161 MiB files, exercise malformed framing, and verify partial-file cleanup after cancellation. Android also runs with a 24 MiB Java heap. Native acceptance still needs rendered frames and advancing position on both platforms, along with trusted Play, pre-play egress, redirect and idle failure, revocation, and killed-process cleanup checks.


The Android picture uses decoder-reported dimensions to preserve aspect ratio
within the host width and 55% of its height. Portrait pictures are centered in
the native panel. Later valid size callbacks and host resizing recompute that
fit. iOS uses `AVPlayerLayer.resizeAspect` within its existing bounded picture.
These layout rules leave native Play, pause and close controls in the panel.


## Selected live MP3 profile

`finite-live-mp3-v1` adds foreground, shell-owned MP3 radio. It does not turn an existing finite-video grant into live access. A fresh access review records a different support identity even when the requested domains are identical. Declining preserves the old grant; an exact saved pin can still reopen with finite access and its previous Common and CVM grants. Declarations without Media keep their previous review bytes. Already mounted cards retain their immutable configuration; close the card and open its publication from Discover to request renewal.

The native-only `mediaProfile` field is emitted solely from the branded admission's effective reviewed profile when Media is actually granted. Absence means finite-only. Both native parsers reject other values, bundled configurations and live profiles without Media. The native live permit additionally checks that exact enum, current user/epoch, published generation, foreground focus and review revision. Guest `live:true` selects a request shape, never authority. An old finite grant receives an immediate correlated creation error and no transfer.

The native source card shows the immutable HTTPS URL and **15-minute / 32 MiB** limits. Only native Play starts or resumes the connection and output. Publisher autoplay and Play-on-capabilities do not substitute for it. Initial and paused capabilities omit Play; a publisher can pause or stop its own current session. Native resume reconnects at the live edge under the original clock and cumulative byte allowance. No seek, queue, artwork, napplet-owned playback, background service or automatic resume is added.

| Live bound | Selected limit |
| --- | --- |
| Original session | 15 minutes from first native Play, including pauses and background time |
| Cumulative input | 32 MiB of decrypted HTTP response bytes, including headers, chunk framing and redirects, across resumes |
| Startup / input idle | 15 seconds per attempt / 10 seconds without HTTP response progress |
| Redirects | Three public HTTPS hops; URL, all DNS answers, numeric endpoint, TLS name and trust are checked on every hop |
| HTTP parsing | HTTP/1.0 or 1.1; 32 KiB head, 128 fields, ASCII field profile; 128-byte chunk line; 8 KiB / 32-field trailers |
| Read handoff | At most 8 KiB; one extra byte may be read to detect overflow, never admitted to the decoder |
| Android input | 512 KiB compressed ring plus 64 KiB retained prefix; older backward reads fail, without fetching |
| Apple output | Four fixed 16 KiB queue buffers and 512 packet descriptions per buffer |
| MP3 admission | Complete Layer III frames up to 2048 bytes, 8–48 kHz, mono/stereo; constant version/rate/channel count, variable bitrate allowed |
| Metadata | Initial ID3v2.2–4 prefix, 64 KiB aggregate maximum; stripped before the platform parser |
| Source ownership | One native Media reservation across finite video and live radio, held through actual transport and decoder unwind |

The session clock uses Android elapsed realtime and Swift ContinuousClock, which include device sleep. Timers are wake-up mechanisms; authority and byte reads recheck the original budget. A pause or reconnect cannot renew it.

The streaming reader is independent of the finite-file reader. It accepts audio/mpeg with identity encoding and either exact Content-Length, chunked framing, or connection EOF. It rejects ambiguous length/transfer fields, duplicate fields, compression, nonzero ICY metadata intervals, chunk extensions, critical trailers, trailing framed bytes, playlists and other codecs. It requests no ICY interleaving. Initial frame alignment is required; free-format MP3, midstream metadata, format changes and incomplete final frames are unsupported. These are selected format limits, not a complete HTTP or MP3 conformance claim.

The existing public URL/DNS/TLS policy is reused. No cookies, Authorization, caller headers or decoder networking fallback are supplied. Android MediaPlayer receives only an app-owned MediaDataSource with unknown size. Apple AudioFileStream and AudioQueue receive supplied complete MP3 frames. No stream URL enters a platform decoder, no whole response is buffered, and no stream file or durable cache is created. These app-owned bounds do not establish a hard total process/codec memory limit.

Foreground/focus loss, interruption, close, identity replacement and generation revocation cancel the connection and revoke decoder input/output. Paused sessions retain only their original allowance. Retirement delivers one terminal event after known resources drain. An uncertain native disposal remains reserved and reachable; a repeated close cannot manufacture success. Another source then requires app restart. iOS keeps the existing AudioSession category policy; Silent-switch and actual route behavior remain platform acceptance limits.

Finite-to-finite replacement retains its existing creation/preemption behavior. A transfer that was already stopping still settles before the next Play. Cross-mode switching uses a busy result: close the other video or radio player and retry. No queued handoff or hidden parallel transfer is introduced. A paused finite decoder remains reserved until its player is closed. Resource, Artifact, Upload and Relay limits are unchanged.

The network-free and owned-loopback checks cover framing, HTTP response budgets, MP3 prefix/frame bounds, native profile renewal, cancellation and stale/drain ownership. Android presentation-clock and Apple queue-consumption observations establish progress, not acoustic output. Earlier isolated iOS launch attempts were inconclusive; host macOS AudioQueue results and iPhoneOS compilation do not substitute for ordinary iOS playback. Public station GET framing and sustained codec/PSS behavior still need source-reviewed native Play and final Android/iOS acceptance. HEAD metadata alone does not establish them.
