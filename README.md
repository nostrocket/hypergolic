<p align="center">
  <img src="assets/brand/hypergolic-logo.png" alt="Hypergolic — a four-point orange spark" width="160" height="160">
</p>

<h1 align="center">Hypergolic</h1>

<p align="center">A native home for Nostr napplets.</p>

Hypergolic is an Android and iOS shell for small web applications called
**napplets**. It brings them into one workspace while keeping identity selection,
permissions, event approval and native operations in the shell.

**Development preview.** The current source includes published napplet loading,
signing and relay integration. Full Android/iOS acceptance, dependency review and
final quality checks remain open. Use disposable test identities and keep an
independent backup of any key you import.

## Current scope

- Open verified published napplets from a Nostr address, review requested access,
  pin a version and explicitly accept updates.
- Switch between loaded napplets, view their overview and restore saved workspace
  state for each account.
- Create or import a local identity, manage saved accounts and select a signing
  method: a local key, a NIP-46 remote signer, or an Android NIP-55 signer app.
  Method selection is explicit; signing does not fall back to another method.
- Review individual events before signing and publication. Relay reads, uploads,
  resources, links, inter-napplet routing, notifications, configuration and Outbox
  routing have selected native implementations.

These are implementation claims, with scoped tests rather than complete product
acceptance. NIP-55 is Android-only. Hypergolic does not currently act as a signer
provider for other applications. Value transfers and zaps are outside the MVP.

## Run locally

Use **Node 24.20.0** and **pnpm 10.34.5**. Install the platform toolchain described
in the [development guide](docs/development.md). Custom native modules require a
native build.

```sh
pnpm install --frozen-lockfile
pnpm run runtime:install
pnpm run quality:install
```

For Android, start an emulator or connect a development device, then run:

```sh
pnpm run prebuild:android
pnpm run android
```

For iOS, use a Mac with Xcode, CocoaPods and an iPhone running iOS 18.4 or later:

```sh
pnpm run prebuild:ios
cd ios
pod install
cd ..
pnpm exec expo run:ios --device
```

Configure your development team in `ios/Hypergolic.xcworkspace` before building
for an iPhone. Debug builds need Metro running. The normal app requires a physical
iPhone for protected identity storage; Simulator fixtures are documented with the
[native harnesses](tests/native/README.md).

Open Settings from the account avatar to manage identities or open a napplet.
Bundled labs provide development fixtures. See the
[development guide](docs/development.md) for standalone Android packaging and
platform requirements.

## Trust and recovery

Verified artifacts remain untrusted web content. The native hosts and bundled
Kehto runtime mediate a selected capability profile; a publisher signature does
not grant access by itself. Napplets do not receive secret keys.

Local signing keys and external-signer connection secrets are held by native
owners. Manual local-key backup and deletion require device authentication.
Ordinary napplet data is stored in scoped local SQLite; it is not an encrypted
application-data vault. Bulk application-data export and migration are unfinished.
Native security and recovery acceptance remain open.

The app uses Expo and React Native for the shell, Kehto for the web runtime and
Applesauce for selected Nostr integration. Hosted Expo updates are disabled.
Local builds still depend on package registries and platform toolchains; iPhone
installation requires Apple's signing infrastructure.

See the [architecture](docs/architecture.md),
[native boundary](docs/native-contract.md),
[capability contract](docs/capability-contract.md) and
[signing core](docs/signing-core.md) for details and limits.

## Development and contributions

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [whole-app test plan](docs/testing.md).
Useful local checks include:

```sh
pnpm run test:shell
pnpm run test:security
pnpm run test:storage
pnpm run test:capabilities
pnpm run test:signer
pnpm run check
```

`check` covers types, diagnostics and dependency audits; it does not run every
behavioral or native test. Builds and static scores do not establish native
security or release readiness.

## License

Licensed under [MIT](LICENSE). Third-party components retain their respective
terms; see [notices and provenance](docs/native-dependency-notices.md).
