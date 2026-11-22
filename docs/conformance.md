# Shell protocol conformance

Run `pnpm run conformance` from the repository root to compare Hypergolic with its pinned NIP-5D draft and NAP requirements. Each row links to its specification and any accepted issue. Chromium and WebKit exercise the built host with the bundled UX Lab guest. Component cases call the production handlers with local fixtures.

## Run locally

Use the Node and pnpm versions in the [development guide](development.md). Install the root and runtime dependencies and the two browser engines once.

```sh
pnpm install --frozen-lockfile
pnpm run runtime:install
pnpm --dir runtime exec playwright install chromium webkit
pnpm run conformance
```

Use `pnpm run conformance --strict` to return a failure while any measured or reviewed gap is present. Use `--json report.json` or `--markdown report.md` to write a report. The default command is the same regression gate that runs on pull requests and pushes to main. Open the workflow summary for the table or download the **shell-conformance** artifact. The README issue count includes all open conformance work, including requirements with no automated case yet. [CI runs](https://github.com/nostrocket/hypergolic/actions/workflows/check.yml) · [Open conformance issues](https://github.com/nostrocket/hypergolic/issues?q=is%3Aissue%20is%3Aopen%20label%3Aconformance)

## Read a result

| Result | Effect on the default gate |
|---|---|
| Pass | The stated observation held for this build. |
| Known gap | This individual check failed as recorded in its linked issue. |
| Regression or check error | CI fails. Inspect the observation, browser setup, missing case or changed review evidence. |
| Retire baseline | A previously failing check passed. Remove its issue exception from that rule and keep the check. Other parts of the issue may still be open. |

The rule catalog covers selected operations in all eighteen ordinary shell domains. For example, Config has separate cases for a default the user never touched and a value the user explicitly saved. Two browser results for the same defect count as one issue. Passing an individual rule gives evidence about that observation. Physical devices, operating-system signers and any untested operations retain their own acceptance requirements. [Rule catalog](../tools/conformance/rules.mjs) · [Component cases](../tools/conformance/component-cases.mjs) · [Device acceptance](testing.md)

The signing check submits encrypted requests through Relay and Outbox and checks that both refuse them before review. A cleartext request exercises the ordinary path. Physical signer and relay checks have their own acceptance requirements. [Signing issue](https://github.com/nostrocket/hypergolic/issues/106)

## Follow upstream changes

`pnpm run conformance:drift` compares the pinned file bytes with the corresponding live branches on GitHub. The scheduled workflow runs daily at 03:23 UTC and maintains one review issue when documents change. An upstream read failure fails the job and leaves the issue alone. The checker on a pull request continues to use its reviewed pins.

Review the linked text, adjust affected cases, and update the pin in the same PR. For new rules, choose a stable ID, identify the exact requirement, and register an observation in the runner. A setup error must throw. A known-gap exception belongs to the individual behavior it covers. Prefer an existing named component test when it directly observes the requirement. [Watched documents](../tools/conformance/specs.json) · [Drift workflow](../.github/workflows/protocol-drift.yml)

The independent Lean model provides a reference shell and saved input/output traces. CI replays seven settings operations against Hypergolic’s Config broker, including invalid schemas, default values, subscription and a user edit. It compares every reply and push, allowing human-readable error wording to vary. The fixture includes its exact upstream revision and both files’ Git blob IDs are checked locally. The model shares the pinned NIP-5D revision and incorporates newer NAP proposals. Review each new trace against the applicable NAP revision before adding it to the gate. [Config trace and license](../tests/presentation/fixtures/lean-config/README.md) · [Reference model and pinned sources](https://github.com/nostrocket/Nostr-Applet-Protocol-Formal-Verification/blob/7fa21cd5bb54e4772879aeef08b0905d561c9016/lean/README.md)
