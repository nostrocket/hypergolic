/** Sign exact Routing Lab bytes with public test scalars 2 and 3; never publish. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {naddrEncode} from 'nostr-tools/nip19';
const root=new URL('../../../',import.meta.url),secret=new Uint8Array(32);secret[31]=2;
const hash=value=>createHash('sha256').update(value).digest('hex');
const html=await readFile(new URL('runtime/fixtures/routing-lab.html',root),'utf8'),htmlHash=hash(html),aggregate=hash(htmlHash+' /index.html\n');
const rows=[['caller',['intent','inc']],['peer',['intent','inc']],['second-peer',['intent','inc']],['no-routing',['theme']],['auto-peer',['intent','inc','storage']],['collision-peer',['intent','inc']]].map(([role,domains])=>{
 const appId='signed-routing-'+(role==='collision-peer'?'peer':role)+'-lab', bytes=role==='auto-peer'?html.replace('<head>', '<head><meta name="routing-auto-topic" content="true">'):html, artifactHash=hash(bytes), artifactAggregate=hash(artifactHash+' /index.html\n');
 const event=finalizeEvent({kind:35129,created_at:1790992800,content:'',tags:[['d',appId],['path','/index.html',artifactHash],['x',artifactAggregate,'aggregate'],...domains.map(domain=>['requires',domain]),...(role.includes('peer')?[['archetype','note','napplet:note/open']]:[])]},role==='collision-peer'?Uint8Array.from([...new Uint8Array(31),3]):secret);
 return {role,appId,event,address:naddrEncode({kind:35129,pubkey:event.pubkey,identifier:appId}),htmlHash:artifactHash,html:bytes};
});
await writeFile(new URL('tests/native/routing/published-fixture.ts',root),'/** Generated local signed artifacts; public test scalars 2 and 3. No publication. */\nexport const SIGNED_ROUTING_ARTIFACTS = '+JSON.stringify(rows)+' as const;\n');
console.log(JSON.stringify(rows.map(({role,appId,event,htmlHash})=>({role,appId,eventId:event.id,publisher:event.pubkey,htmlHash}))));
