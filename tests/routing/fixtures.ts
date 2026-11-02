import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { verifyArtifact, verifyManifest } from '../../src/napplets/verified-artifact.ts';
export async function artifact(seed = 9, appId = 'notes', role = 'note', timestamp = 1_800_000_000, conventions = ['napplet:note/open', 'napplet:note/edit']) {
  const secret = new Uint8Array(32); secret[31] = seed;
  const html = new TextEncoder().encode('<!doctype html><html><head></head><body>handler</body></html>');
  const sha = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const hash = await sha(html), aggregate = await sha(new TextEncoder().encode(`${hash} /index.html\n`));
  const pubkey = getPublicKey(secret);
  const event = finalizeEvent({ kind: 35129, created_at: timestamp, content: '', tags: [['d', appId], ['path', '/index.html', hash], ['x', aggregate, 'aggregate'], ['requires', 'theme'], ['archetype', role, ...conventions]] }, secret);
  return verifyArtifact(await verifyManifest({ kind: 35129, pubkey, identifier: appId, relayHints: [] }, JSON.parse(JSON.stringify(event))), html);
}
