// Disposable public test key only. No fixture contact or upload is performed.
import { createHash } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools/pure';
const key = new Uint8Array(32); key[31] = 1;
const hash = process.argv[3] ?? createHash('sha256').update(new Uint8Array([1,2,3])).digest('hex');
if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid fixture hash');
const destination = process.argv[2] ?? 'https://files.example.com';
const server = new URL(destination).hostname;
const event = {kind:24242, created_at:1000, tags:[['t','upload'],['x',hash],['server',server],['expiration','1120']],
  content:'Upload reviewed file to '+destination};
const wire = value => ({id:value.id,pubkey:value.pubkey,created_at:value.created_at,kind:value.kind,tags:value.tags,content:value.content,sig:value.sig});
const sign = value => wire(finalizeEvent(value,key));
try {
  const good = sign(event);
  const variants = [good, sign({...event,tags:event.tags.map(tag=>tag[0]==='x'?['x','b'.repeat(64)]:tag)}),
    sign({...event,tags:event.tags.map(tag=>tag[0]==='server'?['server','other.example.com']:tag)}),
    {...good,pubkey:'b'.repeat(64)}, sign({...event,kind:1}),
    sign({...event,tags:event.tags.map(tag=>tag[0]==='expiration'?['expiration','9999']:tag)}),
    {...good,id:'b'.repeat(64)}, sign({...event,tags:[...event.tags,['server','other.example.com']]}),
    sign({...event,tags:event.tags.filter(tag=>tag[0]!=='x')}), {...good,sig:'bad'},
    sign({...event,content:'Other purpose'}), {...good,extra:'authority'}];
  process.stdout.write(JSON.stringify(variants.map(value=>Buffer.from(JSON.stringify(value)).toString('base64url'))));
} finally {key.fill(0);}
