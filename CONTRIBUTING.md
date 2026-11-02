# Contributing

Hypergolic is a development preview targeting Android and iOS. Read the
[architecture](docs/architecture.md), [development guide](docs/development.md) and
[engineering instructions](AGENTS.md) before changing behavior.

## Report a problem

Include the source revision, platform and OS version, steps to reproduce, expected
behavior and observed result. Use disposable identities in reproductions and
remove keys, connection links, personal data and private filesystem paths from
logs and screenshots.

Follow [SECURITY.md](SECURITY.md) for sensitive reports.

## Make a change

Use the pinned Node and pnpm versions and frozen lockfiles. Keep changes focused
and preserve unrelated work. Expo generates `android/` and `ios/`; permanent
native configuration belongs in `app.json`, config plugins or local modules.

Describe the behavior changed, the reason for it and the checks performed. Add
regressions for changed behavior, especially denial, cancellation, stale replies,
account changes, restart and uncertain outcomes. Keep implementation claims
separate from observed runtime results and remaining acceptance work.

Protocol and security-policy changes need an agreed contract. Record the owning
specification revision, supported operations, caller binding and lifecycle limits;
library exports alone do not establish conformance. Do not widen capabilities or
add an automatic signing fallback as an incidental fix.

## Check the work

Run `pnpm run check` and the focused suites for your change. The root
`package.json` lists shared tests by area; the [native harnesses](tests/native/README.md)
and their local READMEs describe platform-specific prerequisites and effects.
For runtime changes, use `pnpm run runtime:test`; for native/config-plugin changes,
regenerate and compile each affected platform. Documentation-only changes need
link, command, whitespace and privacy checks.

The final quality requirement is React Doctor and aislop at 100/100 without
hiding findings. A local React Doctor run with scoring disabled does not provide
that numeric result. Report blocked or unrun checks explicitly. Compilation,
browser fixtures and Simulator results each have a narrower scope than complete
Android/iOS acceptance.

Use disposable test environments for harnesses that change device state. Preserve
the normal app's identity and data, clean up temporary test apps and resources,
and verify cleanup. Do not commit signing keys, device evidence or generated
native projects.
