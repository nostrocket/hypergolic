import {createHash} from 'node:crypto';
import {verifyEvent} from 'nostr-tools/pure';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const {authorization, sha256, size} = JSON.parse(input);
if (typeof authorization !== 'string' || !authorization.startsWith('Nostr ')) throw Error('Missing authorization');
const token = authorization.slice(6), bytes = Buffer.from(token, 'base64url');
if (bytes.toString('base64url') !== token || token.length > 4096) throw Error('Invalid token');
const event = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)), now = Math.floor(Date.now() / 1000);
if (Object.keys(event).sort().join() !== ['id','pubkey','created_at','kind','tags','content','sig'].sort().join() ||
  !verifyEvent(event) || event.pubkey !== '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' ||
  event.kind !== 24242 || !Number.isSafeInteger(event.created_at) || event.created_at >= now || now >= event.created_at + 120 ||
  event.content !== 'Upload reviewed file to https://files.example.com:19943' || JSON.stringify(event.tags) !==
    JSON.stringify([['t','upload'],['x',sha256],['server','files.example.com'],['expiration',String(event.created_at + 120)]])) throw Error('Wrong signed scope');
process.stdout.write(JSON.stringify({eventId: event.id, pubkey: event.pubkey, sha256, size, authorizationSha256: createHash('sha256').update(authorization).digest('hex'), signatureVerified: true}));
