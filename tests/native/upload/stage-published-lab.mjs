/** Explicitly sign the reviewed staged bytes with public test scalar 2; never publish. */
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {naddrEncode} from 'nostr-tools/nip19';
const root = new URL('../../../', import.meta.url);
const html = await readFile(new URL('runtime/fixtures/upload-lab.html', root), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = hash(html), aggregate = hash(digest + ' /index.html\n');
const secret = new Uint8Array(32); secret[31] = 2;
const event = finalizeEvent({kind: 35129, created_at: 1790859879, content: '', tags: [['d', 'signed-upload-lab'], ['path', '/index.html', digest], ['x', aggregate, 'aggregate'], ['requires', 'upload']]}, secret);
const address = naddrEncode({kind: 35129, pubkey: event.pubkey, identifier: 'signed-upload-lab'});
await writeFile(new URL('tests/native/upload/published-fixture.ts', root), '/** Generated public local signed artifact; it has not been published. Publisher key is public test scalar 2. */\nexport const SIGNED_UPLOAD_EVENT = ' + JSON.stringify(event) + ' as const;\nexport const SIGNED_UPLOAD_ADDRESS = ' + JSON.stringify(address) + ';\nconst html = ' + JSON.stringify(html) + ';\nexport function signedUploadBytes(): Uint8Array {return new TextEncoder().encode(html);}\n');
process.stdout.write(JSON.stringify({eventId: event.id, htmlSha256: digest, aggregate}) + '\n');
