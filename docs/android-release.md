# Android release candidates

The first Android release uses `space.hypergolic`, version `0.1.0`, versionCode
`1`, and ARM64. Expo remains the app framework; this build path uses GitHub
Actions and Gradle directly and needs no Expo/EAS account.

`app.json` holds the version and development ID. `app.config.js` selects the
production ID from `config/android-release.json` when
`HYPERGOLIC_VARIANT=production`. The release command sets this itself. Ordinary
development commands keep `org.nostrocket.hypergolic.dev`; it installs separately
from production. Neither installation transfers the other's identities or data.
The iOS bundle identifier remains a development identifier.

New production identities start with an empty workspace and the normal Discover
entry; development identities retain the three UX Lab fixtures. Production Settings hides native signer checks, fixture publishing, signed-host
labs and bundled test launchers. The fixture publisher is not constructed and
the bundled-launch handler is disabled. About shows installed version/build,
website, downloads, help, privacy and source/notices links. Native fixture assets
and test implementations still exist in the binary; hiding entry points does not
prove their removal or replace native authority tests. Ordinary Discover and
verified published opening remain available.

## One-time signing setup

The production certificate fingerprint is deliberately unset. Signing stops
until the owner creates the permanent key and registers its public fingerprint.
Do this in a private terminal, outside the repository:

```sh
mkdir -p "$HOME/.config/hypergolic/signing"
chmod 700 "$HOME/.config/hypergolic/signing"
keytool -genkeypair -keystore "$HOME/.config/hypergolic/signing/android-release.p12" \
  -storetype PKCS12 -alias hypergolic -keyalg RSA -keysize 4096 -validity 10000 \
  -dname 'CN=Hypergolic'
chmod 600 "$HOME/.config/hypergolic/signing/android-release.p12"
keytool -list -v -keystore "$HOME/.config/hypergolic/signing/android-release.p12" \
  -alias hypergolic
```

Let `keytool` prompt for the password; do not put it in shell history or chat.
PKCS12 uses the same password for this key and its store. Keep an encrypted
backup and password-manager record, then verify that the backup opens. Losing
the key prevents ordinary updates to existing installations. Use the same key
for GitHub, website and Zapstore APKs.

Set `signingCertificateSha256` in `config/android-release.json` to the displayed
SHA-256 certificate fingerprint, without colons (64 hexadecimal characters).
This fingerprint is public; the keystore and passwords are secrets. Review and
commit this configuration before creating the release candidate.

Create the GitHub environment **android-release**, restrict its deployment
branches to `main`, and configure a required maintainer reviewer. Add:

| Environment secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 encoding of the complete keystore file |
| `ANDROID_KEY_ALIAS` | `hypergolic` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_PASSWORD` | Key password (same for this PKCS12 key) |

Enter secrets through GitHub's secret settings or the GitHub CLI's stdin/file
support. Never add them to source, Notes, logs or APK attachments. Environment
protection is repository configuration; merging the workflow does not create
reviewer rules or secrets automatically. Review source and workflow changes
before approving access to that environment.

## Candidate process

1. Merge the reviewed source, fingerprint and version into `main`. Wait for the
   existing **CI** workflow to succeed for that exact commit.
2. Manually run **Android release candidate** on `main`. Other branches and forks
   cannot run its build job. A concurrent candidate run waits rather than
   interrupting an in-progress signer.
3. The build job installs frozen dependencies and produces a fresh unsigned APK
   without signing secrets. The protected signing job runs on a separate runner,
   installs no application dependencies, verifies the source receipt and signs.
4. The final job gets repository-write access and creates a **draft** release
   `v0.1.0` containing the signed APK, `SHA256SUMS` and `build.json`. It cannot
   replace an existing release. A draft is not an anonymous download channel.
5. Test those exact bytes without Metro using the Android-applicable
   [acceptance matrix](../tests/acceptance-matrix.json). Record the SHA-256,
   device/OS coverage, first launch, identity recovery, Discover/opening,
   permissions, data isolation/restart, Outbox and external signer results.
   Include a same-key update with a higher versionCode and a 16 KB page-size
   environment. Preserve identity-bearing installations.
6. Finish release notes and notice review, then explicitly publish the accepted
   draft. Publication is a separate maintainer action. Distribute the same APK
   and checksum through all channels; never rebuild after acceptance.

If a candidate needs changing, update the version/versionCode as appropriate
and create a new candidate. Published updates always increase versionCode and
retain the application ID and signing certificate. Existing drafts need explicit
maintainer reconciliation; the workflow will not overwrite their assets.

The packaging checks require clean committed source, matching package/config
versions, the production Expo config embedded in the APK, ARM64-only native
libraries, non-debug/non-test flags, the reviewed permission set, packaged notice
manifests, 16 KB ELF segment alignment, ZIP alignment, a valid signature and the
registered certificate. The receipt binds the commit, unsigned input digest and
final APK digest. These checks do not establish reproducible builds or complete
product, licensing or security acceptance. See [native notices](native-dependency-notices.md)
for remaining attribution review, and [testing](testing.md) for open acceptance.

## Local packaging

Use the pinned [development toolchain](development.md), including Android Build
Tools **36.0.0** alongside **37.0.0**, and install frozen root/runtime dependencies.
Use new output directories outside the checkout; a dirty source tree or existing
output directory is rejected.

```sh
pnpm run test:release
pnpm run build:release /absolute/private/path/candidate-unsigned
```

For signing, provide `HYPERGOLIC_KEYSTORE_PATH`, `HYPERGOLIC_KEY_ALIAS`,
`HYPERGOLIC_KEYSTORE_PASSWORD` and `HYPERGOLIC_KEY_PASSWORD` through your private
secret manager or non-echoing terminal input. The keystore must be outside the
checkout. With those values in the environment:

```sh
pnpm run sign:release /absolute/private/path/candidate-unsigned /absolute/private/path/candidate-signed
```

The signer passes password values only to `apksigner sign` through environment
variables, never command-line arguments. Exit the private shell or unset them
when finished. The build subprocess environment excludes signing credentials,
repository tokens and inherited Node/Expo overrides. Do not run concurrent
Android prebuild/Gradle jobs; release and tester packaging share a build lock.
Existing `build:tester` remains for interactive development previews.

## Distribution setup still needed

Before launch, make `https://hypergolic.space` serve download/support and privacy
information, and verify every About link after the new documents reach `main`.
The site can link to the GitHub APK; a separate binary host is unnecessary.
GitHub Releases also supplies the upstream source for Obtainium.

Choose the project's Nostr publisher identity, then use the current
[Zapstore publisher flow](https://zapstore.dev/docs/publish) to prepare metadata,
screenshots and certificate linkage. Publish its listing only after the accepted
GitHub APK is public. APK signing and Nostr catalog signing are separate keys.
Website deployment, Zapstore publishing, Obtainium import validation and full
Android device acceptance are follow-up launch work. iOS App Store packaging
and full iOS acceptance remain separate.
