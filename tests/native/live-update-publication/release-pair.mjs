import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { naddrEncode } from 'nostr-tools/nip19';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

const MARKERS = ['update-v1', 'update-v2'];
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9-]{0,11}[a-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRIVATE_SUFFIXES = new Set(['local', 'localhost', 'internal', 'lan', 'test', 'example', 'invalid', 'onion', 'arpa']);

function publicDnsHostname(hostname) {
  const labels = hostname.split('.');
  return !isIP(hostname) && hostname.length <= 253 && labels.length >= 2 &&
    labels.every(label => DNS_LABEL.test(label)) &&
    !PRIVATE_SUFFIXES.has(labels.at(-1)) && /^[a-z]{2,63}$/.test(labels.at(-1));
}

function serverBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || !publicDnsHostname(url.hostname)) throw new Error('A public HTTPS Blossom origin is required');
  return url.origin + '/';
}

function lookupRelays(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 4) throw new Error('One to four lookup relays are required');
  const relays = values.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || !publicDnsHostname(url.hostname)) throw new Error('Public WSS lookup relays are required');
    return url.origin;
  });
  if (new Set(relays).size !== relays.length) throw new Error('Duplicate lookup relay');
  return relays;
}

export function makeHtml(marker) {
  if (!MARKERS.includes(marker)) throw new Error('Unknown QA marker');
  return '<!doctype html><html><head><title>Hypergolic live update QA</title>' +
    '<style>body{margin:0;background:#1b1612;color:#f8f5f2;font:600 20px system-ui;padding:24px}</style>' +
    '</head><body><main id="update-marker">' + marker + '</main>' +
    '<script>window.parent.postMessage({type:"shell.ready"},"*");</script></body></html>';
}

/** Build two public signed revisions. The caller retains the secret only in memory for Blossom upload. */
export function makeReleasePair(secret, { identifier, server, relays, createdAt }) {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32 ||
      typeof identifier !== 'string' || !IDENTIFIER.test(identifier) ||
      !Number.isSafeInteger(createdAt) || createdAt < 2) throw new Error('Invalid QA release input');
  const blossom = serverBase(server);
  const lookup = lookupRelays(relays);
  const pubkey = getPublicKey(secret);
  const revisions = MARKERS.map((marker, index) => {
    const html = makeHtml(marker);
    const hash = sha256(Buffer.from(html));
    const aggregate = sha256(`${hash} /index.html\n`);
    const event = finalizeEvent({ kind: 35129, created_at: createdAt + index, content: '', tags: [
      ['d', identifier], ['path', '/index.html', hash], ['x', aggregate, 'aggregate'],
      ['server', blossom], ['requires', 'theme'],
    ] }, secret);
    if (!verifyEvent(event)) throw new Error('Unable to sign QA release');
    return { marker, html, hash, aggregate, event: JSON.parse(JSON.stringify(event)) };
  });
  return {
    schemaVersion: 1, publisher: pubkey, identifier, naddr: naddrEncode({
      kind: 35129, pubkey, identifier, relays: lookup,
    }), server: blossom, relays: lookup, revisions,
  };
}

/** Reject a tampered handoff file before publishing any event from it. */
export function validateReleasePair(bundle) {
  if (!bundle || bundle.schemaVersion !== 1 || typeof bundle.publisher !== 'string' ||
      typeof bundle.identifier !== 'string' || !IDENTIFIER.test(bundle.identifier) ||
      !Array.isArray(bundle.revisions) || bundle.revisions.length !== 2) throw new Error('Invalid QA release bundle');
  const server = serverBase(bundle.server);
  const relays = lookupRelays(bundle.relays);
  if (bundle.naddr !== naddrEncode({ kind: 35129, pubkey: bundle.publisher,
    identifier: bundle.identifier, relays })) throw new Error('QA coordinate changed');
  for (const [index, revision] of bundle.revisions.entries()) {
    const hash = sha256(Buffer.from(revision.html));
    const aggregate = sha256(`${hash} /index.html\n`);
    const event = revision.event;
    if (revision.marker !== MARKERS[index] || revision.html !== makeHtml(revision.marker) ||
        revision.hash !== hash || revision.aggregate !== aggregate ||
        event?.kind !== 35129 || event.pubkey !== bundle.publisher || !verifyEvent(event) ||
        JSON.stringify(event.tags) !== JSON.stringify([
          ['d', bundle.identifier], ['path', '/index.html', hash], ['x', aggregate, 'aggregate'],
          ['server', server], ['requires', 'theme'],
        ])) throw new Error('QA release verification failed');
  }
  if (bundle.revisions[1].event.created_at <= bundle.revisions[0].event.created_at ||
      bundle.revisions[0].event.id === bundle.revisions[1].event.id) throw new Error('QA revisions are not ordered');
  return bundle;
}
