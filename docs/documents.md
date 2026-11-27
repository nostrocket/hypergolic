# Napplet documents

Hypergolic implements a bounded profile of the [NAP-FS draft at bd1b9e9](https://github.com/napplet/naps/blob/bd1b9e912f05203bf38f7a1b04f920744fe6d625/naps/NAP-FS.md). A published napplet that receives File System access gets a virtual `/Documents` directory private to the selected account, publisher and napplet identifier. The directory survives restarts and revisions of that napplet. Storage uses the shell’s local SQLite database under the same device protection as other ordinary app data.

The host supports discovery, direct-child listing, metadata, ranged reads, and atomic replace, append and patch writes. A write can require an exact revision or an absent destination. A conflicting request leaves the document untouched. Each successful write changes the opaque revision. Reads and writes accept up to 128 KiB per call. A file can hold 2 MiB and each napplet has space for 128 files totaling 8 MiB per account.

Both mobile platforms use the shell’s document picker for opening or choosing a save destination inside the virtual directory. Each selection resolves against the requesting live native lease. Moving to the background cancels the picker. Files from external storage providers, nested folders, watches, removal, moves and sharing between napplets are outside this profile. The File System grant does not give access to OS paths. NAP Storage access is independent.

Published Notepad uses its own File menu and directory browser for ordinary saves. Its Browse control can request the shell picker. Notepad may split a large save across several writes. Each request commits atomically, so a later failed append can leave an incomplete multi-request save.

## Verification

The storage tests exercise SQLite reopen, conflict handling, range reads, canonical byte encoding and owner isolation. The native broker tests exercise missing access and a revoked picker lease. The packaged browser test uses the published artifact loader and a test native transport connected to the same SQLite implementation.

A standalone Android development Release build opened the signed Notepad publication, saved an edit, then reopened the saved bytes through the shell picker after process restart and again after upgrading the tester. On a physical Redmi Note 15 Pro 5G running Android 16, the same signed publication created a document, saved an edit and reopened the exact edited text through the shell picker after a cold restart. The packaged Chromium and WebKit hosts also ran the published File menu flow. The iOS Simulator Release build compiled and launched; normal startup required a physical iPhone for identity storage. Physical iPhone document acceptance remains open.

To run the published Notepad UI version of the browser test, set `HYPERGOLIC_NOTEPAD_ARTIFACT` to a local copy of the signed publication’s HTML, SHA-256 `a4dacb9ff7ae3e3543dad675437f0a1817b4d47abd9d97ddedfc869c1f31797e`. The test checks the digest before opening the guest. It saves a document, edits it, reloads the host and opens the saved document. Run the browser check after building the runtime:

```sh
pnpm --dir runtime exec playwright test tests/published-artifact.spec.ts -g 'published documents'
```
