# Notifications and configuration

Hypergolic implements the selected NAP-NOTIFY and NAP-CONFIG drafts through the
published napplet capability boundary. They remain drafts, not released standards.

## Selected contracts

| Contract | Pinned revision | Document SHA256 |
| --- | --- | --- |
| NAP-NOTIFY | [e14f5c9](https://github.com/napplet/naps/blob/e14f5c9d6a6dd2a69ccf79668c4a3c1e955e1ac9/naps/NAP-NOTIFY.md) | `892d338587627f71899a4594096cf08795faa5e9fa230af72c31083f12abc5a2` |
| NAP-CONFIG | [448013e](https://github.com/napplet/naps/blob/448013e6d8cb8c75dce49576b3e7c0d46d960eac/naps/NAP-CONFIG.md) | `2d34af51d84edd4353ec142002d9ffe0a7a5477ce9b0fd71835273fd4034931b` |

The genuine pinned SDK produces the public messages. A captured native registration
supplies identity, publisher, application, artifact version and generation. Guests
cannot select those fields or send trusted shell review decisions. Private request
IDs, native sequence leases, revision checks and captured recipients fence replies
and pushes. The opt-in locked runtime patch exposes the selected domains while
preserving runtime source, session, domain and ACL checks.

## Foreground notifications

The trusted shell attributes each card and badge to its verified application and
publisher. The notification centre supports body clicks, dismissal and up to three
actions. Low-priority notifications appear only in the centre; other priorities
can also show a short foreground toast. The centre entry and compact toast reserve
shell layout space so they do not intercept napplet controls. Guest strings remain plain text. There is
no OS notification or background push service in this profile.

Permission is remembered for one identity, publisher, application and exact
channel. General permission does not authorize named channels. Channels must be
registered before use. The permission review states the requesting source and
channel; Settings lists saved permissions with explicit revocation controls.
Revocation removes that channel's current alerts and badges and prevents pending
work from completing under the old permission. A new request requires fresh
approval.

Loaded foreground napplet switches keep cards and callbacks live. Background,
close, replacement and identity changes clear transient alerts and badges and
revoke old delivery. There is no replay backlog on return. Saved permissions are
separate from transient presentation and remain scoped to their identity.

Card interaction consumes the card. Declining a verified artifact update preserves the old instance, live unclicked cards/badges and callback history; accepting replaces the instance and clears its transient state while retaining the same account/publisher/app/channel permission. New sends/callbacks belong only to the new instance; restart never replays old callbacks.

## Shell-owned configuration

A napplet registers a bounded Core Subset schema and can get or subscribe to
validated values and request its trusted shell editor. The shell is the sole
writer. The editor displays verified source and artifact version, ordered groups,
plain descriptions, enum and boolean controls and validated JSON controls for
primitive arrays or otherwise supported values. Cancel does not save. Save reports
validation errors and preserves the draft; duplicate Save cannot create a second
concurrent write.

Only one editor may be opening while its protected storage read is pending.
A native request must remain live until that editor is presented. Background,
close, identity changes and focus interruption cancel the pending opening. Returning
to the original napplet requires a fresh request; a cancelled read cannot replace
or release a newer editor. Native focus counters also prevent an existing editor
from saving after an interruption, even before lifecycle events reach JavaScript.
Foreground subscriptions retain their separate delivery revision.

Supported schema objects are bounded to depth four. Primitive arrays are
homogeneous. Defaults, required fields, numeric/string/array limits and enum
choices are checked before delivery. References, patterns, unsupported drafts and
secret defaults are rejected. Property defaults take precedence over inherited ancestor defaults under the
selected resolution rules. Invalid values are withheld; an invalid registration
keeps the previous valid schema. A rejected registration returns a negative ACK
and pushes one `config.schemaError` to its captured live requester. The native
reply fallback likewise reports both outcomes, without delivery after revocation.
Schema changes purge removed or invalid secrets.

Configuration persistence is scoped to identity, publisher, application and the
verified aggregate artifact hash. Instance IDs do not alter persistence. A
same-version restart keeps saved values. A newly accepted artifact hash starts a
fresh scope; this profile does not silently migrate values. Declining an update
keeps the currently loaded version and its configuration.

A pending identity confirmation keeps the current configuration endpoint and
subscription. Cancelling does not require another schema registration or subscribe
call. Native review focus is withheld by Settings; an actual confirmed switch
revokes the old endpoint before the selected identity changes.

Secret inputs are masked and never populated with persisted secret text. Explicit
set and clear changes take effect only on Save. A separate native encrypted
configuration namespace holds the whole configuration record, avoiding a split
SQLite/secret transaction. It is separate from identity inventory and nsec slots.
An explicitly supplied secret is delivered in clear text to the authorized napplet
and its same-scope subscribers. It is not safe to supply a secret that the napplet
should never read. A native write already entered may finish in its original scope
after revocation, but no revoked completion or delivery is reported.

The native carrier has a separate maximum structural nesting of forty for routing
messages: schema `properties` and enclosing wire objects add levels beyond schema
object depth. Uploads and other ordinary messages retain the existing depth-twelve
limit. Native byte caps and the stricter schema/value/node limits remain enforced.
The identity-list permission interception also recognizes this routing boundary.

## Interoperability gaps

The selected draft mentions a preferred manifest schema without defining its
encoding. Hypergolic uses public runtime `config.registerSchema`; it does not
invent a manifest encoding. The installed SDK's `config.onSchemaError` returns a
teardown function, while the selected draft describes a subscription close
operation. The fixture calls the installed teardown function. Negative schema
registration ACKs preserve the draft error code on the wire; the SDK displays its
error string without inventing a code prefix.


## Asynchronous lifetime and limits

Notification capacity is rechecked after permission storage and active-authority checks, immediately before allocating an ID/inserting the card, with no intervening asynchronous work. Excess sends return `rate limited` without an ID. Lifetime starts at that final admission: eight-second toast, five-minute centre card. The bounds are 32 global cards, eight per source, 16 channels, badge 0–999, 12 sends and four permission requests per source per minute, and 4096-byte body text. Up to three actions are admitted. Incoming-message rate bounds include rejected messages.

Configuration get, subscribe and registration readback carry the original live native request through protected storage and before pushes. A fresh subscription is admitted only after a successful live read; an expired/failed repeat preserves the old admitted subscription. A subscribe before schema registration receives the canonical error and later valid values. Each subscription has a distinct internal identity; unsubscribe/replacement invalidates pending broadcasts before values or errors. A completed scoped write may remain saved without an expired completion or push.

Native focus-transition counters are separate from routing delivery revisions. Pending/displayed editors capture and recheck this counter through presentation/Save; repeated identical focus properties do not advance it. A cancelled or expired opening releases only its own reservation and cannot replace a newer editor. Runtime config subscribers receive only no-id `config.values` pushes, not correlated get replies. Bounded invalid notification sends receive a generic correlated runtime denial; malformed authority and unbounded/unknown headers acquire no reply/native operation.

## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run `pnpm run test:presentation`, the owning native presentation proofs, and the following documented optional physical-run commands only with reviewed disposable targets and source-bound artifact receipts. The physical scripts do not build a result from missing evidence. Select environment values explicitly; preserve retained app data and verify exact cleanup.

```sh
# Configure the pinned tools described in docs/development.md.
python3 -B tests/native/presentation/build-protected.py --output /tmp/hypergolic-config-build
```

```sh
# Configure the pinned tools described in docs/development.md.
python3 -B tests/native/presentation/test-physical-navigation.py
python3 -B tests/native/presentation/build-notify-observer.py \
  --serial "$ANDROID_SERIAL" --output /tmp/hypergolic-notify-observer
python3 -B tests/native/presentation/notify-physical-android.py \
  --serial "$ANDROID_SERIAL" --npub "$SELECTED_DEVELOPMENT_NPUB" \
  --build "$NORMAL_RECEIPT" --apk "$NORMAL_APK" --section callbacks \
  --ui-jar /tmp/hypergolic-notify-observer/ui-dump.jar \
  --output /tmp/hypergolic-notify-callbacks
python3 -B tests/native/presentation/notify-physical-android.py \
  --serial "$ANDROID_SERIAL" --npub "$SELECTED_DEVELOPMENT_NPUB" \
  --build "$NORMAL_RECEIPT" --apk "$NORMAL_APK" --section channels \
  --ui-jar /tmp/hypergolic-notify-observer/ui-dump.jar \
  --output /tmp/hypergolic-notify-channels
```

```sh
python3 -B tests/native/presentation/notify-expiry-physical-android.py --serial "$ANDROID_SERIAL" --npub "$SELECTED_DEVELOPMENT_NPUB" --build "$NORMAL_RECEIPT" --apk "$NORMAL_APK" --ui-jar /tmp/hypergolic-notify-observer/ui-dump.jar --output /tmp/hypergolic-notify-expiry
```

```sh
# Configure the pinned tools described in docs/development.md.
pnpm run test:presentation
python3 -B tests/native/presentation/test-notify-publisher-selection.py
python3 -B tests/native/presentation/test-protected-builder-restoration.py
python3 -B tests/native/presentation/build-protected.py --suite notifications --output /tmp/hypergolic-protected-notifications
python3 -B tests/native/presentation/notify-publisher-physical-android.py --serial "$ANDROID_SERIAL" --npub "$SELECTED_DEVELOPMENT_NPUB" --build /tmp/hypergolic-protected-notifications/build.json --apk /tmp/hypergolic-protected-notifications/hypergolic-protected-notify.apk --ui-jar /tmp/hypergolic-notify-observer/ui-dump.jar --output /tmp/hypergolic-notification-publishers
```
