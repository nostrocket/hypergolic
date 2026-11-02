# Upload Lab

An unsigned bundled test napplet using the pinned genuine Napplet SDK. It requests a generated red/green two-pixel PNG with filename, caption, metadata and `noTransform`, then displays SDK notifications and explicitly queried status. It carries no signing key or upload credential.

Run `pnpm type-check` and `pnpm build` inside this directory. The reviewed artifact and manifest are explicitly copied into the host runtime fixture catalogue; ordinary published napplets retain the existing capability admission gate while upload acceptance is in progress.

The first native tracer verifies trusted review, separate Reject/Approve once, independent exact stored bytes and the original SDK receipt. Picker, general photo formats, media/attachments and recovery controls are subsequent slices. The upstream reference conformance host lacks upload status subscription support, so its skipped or unsupported cases cannot establish native acceptance.


The original JPEG/HEIC controls embed generated synthetic images with fake
camera/date/GPS/thumbnail metadata. They call the genuine SDK directly, bypassing
system selection, so native upload preparation must sanitize guest-owned originals
before trusted review. `src/public-synthetic-photos.json` pins their input bytes.
They are public test data, not personal photos. No request publishes without
individual trusted approval. Both selected native hosts pass the direct-original review/reject/approved-byte
and scoped SDK receipt journey against the controlled TLS observer.
