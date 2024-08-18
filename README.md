# Hypergolic

A nostr client that implements the nostrocket [NIPS](https://github.com/nostrocket/NIPS).

## Developing

```bash
npm install
npm run dev
```

## Pull Requests

Please only solve ONE problem at a time.

Indicate to others that you are working to solve a particular problem by claiming it on nostrocket or commenting on the github issue so that others do not duplicate your work.

Pull request should contain only ONE commit that solves exactly ONE problem. The probelm SHOULD be from the github or nostrocket issue tracker (but doesn't have to be).

The commit message MUST be a short summary of the problem being solved, usually this should be the same as title of the problem from the github or nostrocket issue tracker.

Do not send pull requests unless they are ready to merge, no "work in progress" pull requests.

### We merge straight into production, so make sure you don't break the build

To test if you did something that breaks the build process, simply run the build process.

```bash
export NODE_OPTIONS="--max-old-space-size=8192"
npm install
npm run build
```

## Style Guide

Avoid uneccessary whitespace changes. Whitespace changes make it difficult to see what code was really changed.

## UX Library

https://www.shadcn-svelte.com/docs

## Getting Paid

Once your pull request has been merged, go to nostrocket.org and submit a Merit Request.

Upon your Merit Request being approved by the existing contributors to Nostrocket, you will be able to sell your Approved Merit Request (there are people wanting to buy these for sats).

Ask in the Telegram group or on Nostr if you need help or have questions.
