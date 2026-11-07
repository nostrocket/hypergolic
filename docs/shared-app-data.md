# Shared application data

Hypergolic supports the public `soy.app-data/1` convention described in
[soyli's pinned shared-data contract](https://github.com/soytec/soyli/blob/a50f9946f9ec1cdefe589f3e60f2d48895347c09/docs/SHARED-DATA.md).
It uses kind 30078 records through existing Outbox or Relay publication and
Identity access. It adds no capability domain or unrestricted signing API.

## Availability and namespace

For a verified published napplet with reviewed Identity access and either
Outbox or Relay access, `shell.ready.capabilities.appData` exposes:

| Field | Hypergolic policy |
| --- | --- |
| `profile` | `soy.app-data/1` |
| `scope` | Namespace derived from the verified publisher, kind and `d` identifier |
| `maxContentBytes` | 3072 UTF-8 bytes for the complete record content |
| `relays` | The first eight configured Network relays, at most |
| `defaultRelays` | The first relay in that selected set |

The scope is SHA-256 of UTF-8 JSON
`["soy.app-data/1", "<publisher>:35129:<identifier>"]`. A new release of the
same publication retains its namespace. A different publisher or identifier
gets a different namespace; account ownership is carried by the event author.
The host derives and captures this context from the verified artifact and
reviewed grants. Guest-supplied policy cannot establish authority.

The hint is omitted for bundled fixtures, missing grants, an empty selected
relay set, or a selected relay URL exceeding the convention's 256-byte limit.
The ordinary napplet can still open without this hint. Relay access does not
grant Outbox access, or vice versa. The existing 8 KiB native configuration and
signed-EVENT limits remain in force.

## Reads and public availability

Structured app-data Outbox queries with explicit configured relay hints use
only those selected storage relays. They avoid unrelated author-relay discovery
and fallback fanout. Other queries keep their existing Outbox routing. Reads
may address another napplet's namespace; writes must use the caller's own scope.

Records are public. A selected relay may reject kind 30078, restrict it to its
owner or fail to retain it. An acknowledgement establishes acceptance by that
relay, not durable storage or anonymous readability. A complete empty query,
an incomplete query and a missing host policy are different outcomes. Guests
must retain that distinction and validate the data they consume.

## Publication, revisions and retry

The host validates the exact six convention tags and the bounded JSON body:
`schema`, `version`, `title`, `previous`, `deleted` and `data`. Content reads
recognize records up to 16 KiB; the smaller advertised write limit preserves
the native event-frame bound. Malformed convention markers cannot fall through
to generic publication.

A record is addressed by kind, publishing account and `d` identifier. Creation
requires `previous: null`; an update names the current signed event ID. Before
review, after approval and after signing, the host checks the current revision
across every selected publication relay. Every relay must complete its query;
an incomplete read cannot authorize a write. Selection uses newest timestamp
and then lowest event ID before payload validation, so an invalid newer record
does not expose an older valid revision as current.

The native review shows the record title, schema, size, public visibility,
account, exact event and destinations. Every event needs approval. Outbox's
complete resolved destination set must fit the configured app-data relay set;
raw Relay uses that configured set. No ancillary relay-list event is sent.
Publication succeeds only when every selected relay accepts the record.
Unknown delivery stays unconfirmed, including when a native result is lost.

Same-account edits to one record are serialized across loaded source instances.
The reservation remains held until in-flight signing/publication work settles,
even after cancellation. Account, source, generation, foreground and settings
changes retain their existing authority checks. This is not an atomic
transaction across relays: independent devices can still race.

An identical retry can reuse the exact signed event from a bounded, session
cache, including after partial or unknown delivery. It requires fresh review
and revision checks; there is no automatic resend. Closing the session removes
its cached events. Changing the event template or destinations is a new request.

Unpublish writes a public tombstone with `deleted: true`, `data: null` and a
current `previous` revision. It does not erase older copies, send a kind 5
deletion or remove linked files. Large assets use the separately reviewed
Upload capability; their URLs and hashes can be stored in a record.

## Verification scope

The shared contract, context, read-routing, planner and approval regressions
live in `tests/runtime/app-data-*.test.ts`. Native policy checks live in
[the app-data harness](../tests/native/app-data-policy/README.md); existing
Outbox and approval harnesses cover the prepared native publication path.

These checks do not establish public relay availability or ordinary-device
usability. Final acceptance separately exercises Discover admission, public
read/empty/error states, reviewed writes, stale revisions, retry, lifecycle and
another reader on the actual Android/iOS artifacts. No public-write acceptance
is implied by compilation or a controlled relay acknowledgement.
