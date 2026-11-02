#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey } from 'nostr-tools/pure';
import { makeReleasePair, validateReleasePair } from './release-pair.mjs';
import { publishRevision, uploadPair, verifyPublicBlob } from './network.mjs';

const DEFAULT_SERVER = 'https://blossom.ditto.pub/';
const DEFAULT_RELAYS = ['wss://relay.damus.io']; // This relay is in the app's configured Lookup list.

function flags(input) {
  const parsed = new Map();
  for (let index = 0; index < input.length; index += 2) {
    if (!input[index]?.startsWith('--') || input[index + 1] === undefined || parsed.has(input[index])) {
      throw new Error('Expected unique --name value options');
    }
    parsed.set(input[index], input[index + 1]);
  }
  return parsed;
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = flags(arguments_);
  if (command === 'plan' || command === 'prepare') {
    const secret = generateSecretKey();
    const bundle = validateReleasePair(makeReleasePair(secret, {
      identifier: 'hgqa-' + randomBytes(4).toString('hex'),
      server: options.get('--server') ?? DEFAULT_SERVER,
      relays: DEFAULT_RELAYS,
      createdAt: Math.floor(Date.now() / 1000) - 2,
    }));
    if (command === 'plan') {
      console.log(JSON.stringify({ action: 'plan-only', naddr: bundle.naddr, publisher: bundle.publisher,
        v1: bundle.revisions[0].event.id, v2: bundle.revisions[1].event.id,
        server: bundle.server, relays: bundle.relays }));
      return;
    }
    const uploads = await uploadPair(bundle, secret);
    const directory = await mkdtemp(join(tmpdir(), 'hypergolic-live-update-'));
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ action: 'prepared', bundlePath, naddr: bundle.naddr,
      publisher: bundle.publisher, v1: bundle.revisions[0].event.id,
      v2: bundle.revisions[1].event.id, uploads }));
    return;
  }
  if (command === 'inspect') {
    const path = options.get('--bundle');
    if (!path) throw new Error('inspect requires --bundle path');
    const bundle = validateReleasePair(JSON.parse(await readFile(path, 'utf8')));
    console.log(JSON.stringify({ action: 'inspected', naddr: bundle.naddr,
      publisher: bundle.publisher, identifier: bundle.identifier,
      v1: bundle.revisions[0].event.id, v2: bundle.revisions[1].event.id,
      relays: bundle.relays, server: bundle.server }));
    return;
  }
  if (command === 'publish') {
    const path = options.get('--bundle');
    const revision = options.get('--revision');
    if (!path || !revision) throw new Error('publish requires --bundle path and --revision v1|v2');
    const bundle = validateReleasePair(JSON.parse(await readFile(path, 'utf8')));
    for (const item of bundle.revisions) await verifyPublicBlob(bundle.server, item);
    const receipt = await publishRevision(bundle, revision);
    console.log(JSON.stringify({ action: 'published', ...receipt }));
    return;
  }
  throw new Error('Usage: cli.mjs plan|prepare [--server https://blossom.example/] or publish --bundle PATH --revision v1|v2');
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'QA publication failed'); process.exitCode = 1; });
