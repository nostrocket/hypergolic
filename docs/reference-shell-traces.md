# Reference shell trace coverage

The conformance check exercises selected behavior from **25 of 43 traces** at model revision `7fa21cd5`. Each trace contributes one result, regardless of how many steps it covers. Tests feed recorded operations into Hypergolic code, observe the result, and compare the agreed fields. Browser startup, platform consent, real signers and network transport have separate tests. Run `pnpm run conformance` for the same table as CI. [Checker guide](conformance.md) · [Model and its source pins](https://github.com/nostrocket/Nostr-Applet-Protocol-Formal-Verification/blob/7fa21cd5bb54e4772879aeef08b0905d561c9016/lean/README.md) · [All upstream traces](https://github.com/nostrocket/Nostr-Applet-Protocol-Formal-Verification/tree/7fa21cd5bb54e4772879aeef08b0905d561c9016/lean/traces)

## Which drafts match

NIP-5D and six NAPs have identical commit pins in the model and shell. Those NAPs are **CVM, INC, Keys, Link, Media and Outbox**. Config, Identity, Intent, Notify, Relay, Resource, Shell, Storage, Theme and Upload have different draft text. The model also follows proposed changes to Shell, Identity and Intent. Common and Lists have no model trace. Display, Proof of Work and Value have no ordinary Hypergolic profile pin. [Compared revisions](../tests/reference-shell/fixtures/drafts.json) · [Hypergolic’s selected documents](../tools/conformance/specs.json)

## What CI compares

| Upstream trace | Operation exercised and comparison boundary |
| --- | --- |
| `sha256` | The artifact verifier rejects the recorded bytes when the signed hash differs (step 3). A local disposable signature authenticates the upstream tags. Frame creation, the separate successful load and shell discovery are outside this case. |
| `config` | Seven post-bootstrap steps compare registration, errors, defaults, subscriptions and a settings edit. Readable error wording can vary. |
| `cvm` | The unsupported optional registry-list operation returns the correlated error (step 6). The model also enables server discovery. |
| `identity`, `identity-examples` | The connected public-key read matches its request ID and returns the trusted registration’s full key. The abbreviated model key is bound to a valid fixture identity. Profile and social-list results are outside these two checks. |
| `identity-teardown` | Closing the endpoint while a follows lookup is pending aborts the read and drops its late result. The test revokes the real broker. |
| `inc`, `inc-channel`, `inc-named` | Two distinct apps exchange topic and channel messages, including missing-target replies, bidirectional delivery and terminal notifications. Ports map to registered recipients, opaque names map consistently, and the fixture approves Hypergolic’s actual review prompt. Explicit close permits a reason. Same-app instances have a separate open issue. |
| `intent` | Step 10 invokes an unregistered role. CI compares the correlated refusal and verifies that no app was activated. Optional role fields and the shell’s legacy `handled` field are checked when present. Launch and history amendments are outside this case. |
| `keys` | Checks the registration acknowledgment, binding snapshot and duplicate-action result against the real Keys session. Hypergolic leaves the suggested Ctrl+S unbound, so it emits no action on forward. The model binds that suggestion. |
| `link`, `link-denied` | The HTTPS request reaches the guest adapter’s native port with the original ID, URL and label. The adapter waits for a controlled native decision and delivers the correlated opened or denied receipt. These cases omit scheme rejection, platform dialogs and actual OS handoff. |
| `notify` | Initial controls and permission denial, focused permission review, user approval, a visible notification card, and click delivery. The model sends controls on first use. Hypergolic announces them at registration. The generated card ID stays bound through the click. |
| `outbox` | Tests explicit relay selection and the acknowledged publication receipt. The planner receives the model signer’s completed timestamp. The receipt validator checks a real locally signed event and a controlled acknowledgment. No relay is contacted. |
| `relay-publish`, `relay-query`, `relay-subscribe` | Approved publication and its receipt, one-shot query, and live event delivery through end-of-stored-events and close. Tests replace abbreviated signatures and keys with signed local events and keep the recorded kind, timestamp, tags and content. Relay hints and caller-close notifications are optional. The stream applies its normal 32-event limit. |
| `resource-cancel` | The adapter starts an in-memory fetch, cancels it, observes the abort, and drops a late result. The transport receives the recorded URL. |
| `storage`, `storage-examples`, `storage-quota`, `restore` | Reads, writes, listing, removal, isolation, invalid requests, quota failure and restored values run against on-disk SQLite through the capability broker. Restore reopens the database before reading. Quota starts with eight bytes left. Tests compare keys as a set and allow explanatory error text to vary. Unbound-port delivery belongs to the browser transport. |
| `theme`, `theme-full` | A published active theme reaches the shell callback and the next read, including fonts and background when supplied. The no-active-theme precondition in the first trace differs from Hypergolic’s always-present system palette. |

## Traces outside the gate

| Upstream trace | Reason |
| --- | --- |
| `nip5d` | Assumes a working transferred MessagePort. The existing Chromium and WebKit transport checks track the open handshake gap. [Issue #98](https://github.com/nostrocket/hypergolic/issues/98) |
| `shell`, `shell-check` | Exercise the proposed compatibility operation and the model’s enabled-domain list. The selected Shell draft requires feature discovery before startup and omits the model’s proposed `shell.check` operation. Browser cases cover early discovery separately. |
| `intent-launch`, `intent-launch-teardown` | Require the explicit launch amendment beyond the shell pin. |
| `cvm-registry`, `media` | The model enables registry discovery and uses napplet-owned playback. The selected shell profiles implement other CVM operations and shell-owned playback. An identical draft pin can still have different enabled features. |
| `upload`, `upload-info`, `upload-refused` | The fixture enables NIP-96 and uses model-specific limits and media. Hypergolic enables Blossom and advertises NIP-96 as disabled. |
| `resource-data`, `resource-fetch` | The model’s test MIME classifier accepts four arbitrary bytes as an octet-stream. Hypergolic’s byte classifier rejects this sample. The pinned draft requires sniffing and permits scheme-specific allowlists. |
| `resource-redirect` | The decision is owned by native DNS and redirect policy. The shared Resource adapter sees the final fetch outcome. |
| `relay-ciphertext` | Requires a separate review of the publishing and encrypted-event policy. The reviewed signing rule and device acceptance remain the evidence for this boundary. |
| `display`, `pow`, `value`, `value-send-refused` | Outside the ordinary shell profile. |

Review this table and the pinned test vectors together when updating a draft or model revision. [Fixture provenance](../tests/reference-shell/fixtures/README.md) · [Registered comparisons](../tools/conformance/reference-cases.mjs)
