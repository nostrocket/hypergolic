# Battleship media regression

These public fixtures reproduce the missing icon in Discover without live relay or HTTP dependencies.

- Kind-35129 event: `a59018965178aeadaa625ec93324190d76109384b61c8e8f8ab16f82620a09c7`.
- Publisher: `266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5`; identifier: `battleship`.
- Icon: 27,388-byte static PNG, 512 × 512; SHA-256 `3c9c0025a017b30af0f0be952c5dec1c9b2584fea65cbbcdcb0b2d5e31befb58`.
- Signed mirrors: `https://cdn.hzrd149.com` and `https://blossom.ditto.pub`.

Read-only retrieval on 18 November 2026 verified the event ID and Schnorr signature, then the icon hash. Both signed mirrors returned the exact icon; all three default Resource Blossom mirrors returned 404. This is a dated observation, not a current availability guarantee. The browser test models those results through the existing Resource facade and blocks browser HTTP requests. It checks the real PNG in the feed and detail page on Chromium and WebKit; native destination enforcement and device journeys remain separate checks.
