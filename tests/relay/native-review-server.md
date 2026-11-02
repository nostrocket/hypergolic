# Native review relay proof server

Run `node tests/relay/native-review-server.mjs --output /private/tmp/<fresh-dir> --mode accept`.
It binds only to loopback and writes a random control nonce in `ready.json`; use that nonce only in the `x-local-review-nonce` header for `POST /control`. `GET /status` and `receipt.json` retain every received frame. The only accepted WebSocket paths represent the three configured default relays. The ignored `.tools/approval-relay-entry.ts` maps exactly those URLs to this server and requires `EXPO_PUBLIC_APPROVAL_RELAY_PORT`.

Modes are `accept`, `reject`, `auth-required`, `close-after-send`, and `hold-upgrade`. In hold-upgrade mode the HTTP upgrade remains unaccepted until a nonce-authorized `{"release":true,"mode":"accept"}` control request. This is local test infrastructure, not relay, approval, signing, or network proof by itself.
