# Routing Lab

Private-development contract fixture built with the pinned Napplet SDK. It exercises intent availability and dispatch, exact topics, channels and retained close records. The generated manifest is unsigned; signed native test variants use explicitly documented disposable public test keys and are never published.

Run `pnpm install --frozen-lockfile`, `pnpm type-check` and `pnpm build` in this directory. The shell owns approval and identity attribution; labels inside this napplet carry no authority.

`pnpm verify` runs type-check, build and the pinned conformance CLI. Its five skipped envelope/lifecycle checks are covered separately by the native SDK journeys, not claimed by this CLI result. Bundled SDK package notices are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
