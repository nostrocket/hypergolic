# Foreground Media playback

This selected profile implements shell-owned, finite HTTPS MP4 playback for verified published napplets. The owning [NAP-MEDIA proposal](https://github.com/napplet/naps/blob/7806f438530251fce5129f8e6239d6b642278759/naps/NAP-MEDIA.md) is a draft. The `media` grant and support profile are specific to this implementation.

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

## Wire and checks

The SDK accepts `createSession`, `destroySession`, `sendCommand` and `command` for this shell-owned profile. It exposes the latest state and capabilities to late subscribers and retains `onEnded` for the endpoint lifetime. The canonical identifier belongs to the generation that created it. Retirement removes native output and command dispatch before one terminal notification. Stale or foreign replies do not select a destination.

The isolated contract checks use a fake native browser transport and matching Java and Swift file-admission cases. Native sink tests stream synthetic 161 MiB files, exercise malformed framing, and verify partial-file cleanup after cancellation. Android also runs with a 24 MiB Java heap. Native acceptance still needs rendered frames and advancing position on both platforms, along with trusted Play, pre-play egress, redirect and idle failure, revocation, and killed-process cleanup checks.


The Android picture uses decoder-reported dimensions to preserve aspect ratio
within the host width and 55% of its height. Portrait pictures are centered in
the native panel. Later valid size callbacks and host resizing recompute that
fit. iOS uses `AVPlayerLayer.resizeAspect` within its existing bounded picture.
These layout rules leave native Play, pause and close controls in the panel.
