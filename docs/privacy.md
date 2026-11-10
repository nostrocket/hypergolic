# Privacy in Hypergolic

Hypergolic is a client for opening napplets and using Nostr identities. This page
describes the application’s data flows so you can choose how to use it.

## Data on your device

The app stores identities, settings, permissions, workspace state and napplet data
on your device. Ordinary SQLite data is not an encrypted vault. Signing keys and
external-signer connection secrets use the app’s native protected storage; the
app does not give these secrets to napplets. Identity backup reveals sensitive
material after device authentication. Keep exported backups private.

## Network activity

Your configured relays and download/upload servers receive requests when you use
the relevant features. These services can see network information such as your IP
address and the requests you send. Nostr publication sends signed events to relays;
other people may retrieve and redistribute public events. Deleting local data does
not remove copies held by relays or other people.

Napplet downloads, images and uploads contact the services needed for those
operations. Review the publisher and requested access before opening a napplet.
The app mediates capabilities; each napplet and external service also has its own
behavior and privacy practices. External signing sends the approved request to
the signer you selected.

## Your controls

Use Settings to review identities, signing methods, relay/server choices and
napplet access. Closing a napplet preserves its saved data. Removing an identity
or clearing application storage has different effects from closing a napplet;
read the confirmation shown for the action before proceeding.

Website, help and source links open outside the app. The destination site’s
privacy practices apply. For questions, use the repository’s issue tracker and
share only information you intend to make public. Never post signing keys or
private connection credentials in an issue.
