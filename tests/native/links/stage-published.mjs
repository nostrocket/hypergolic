/** Sign exact Resource Lab bytes with public test scalar 2; never publish. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {naddrEncode} from 'nostr-tools/nip19';
const root=new URL('../../../',import.meta.url),secret=new Uint8Array(32);secret[31]=2;
const hash=value=>createHash('sha256').update(value).digest('hex');
const html=await readFile(new URL('runtime/fixtures/resource-lab.html',root),'utf8'),htmlHash=hash(html),aggregate=hash(htmlHash+' /index.html\n');
const rows=[['link',['resource','link']],['no-link',['resource']]].map(([role,domains])=>{
 const appId='signed-resource-'+role+'-lab';
 const event=finalizeEvent({kind:35129,created_at:1790992800,content:'',tags:[['d',appId],['path','/index.html',htmlHash],['x',aggregate,'aggregate'],...domains.map(domain=>['requires',domain])]},secret);
 return {role,appId,event,address:naddrEncode({kind:35129,pubkey:event.pubkey,identifier:appId}),htmlHash,html};
});
await writeFile(new URL('tests/native/links/published-fixture.ts',root),'/** Generated local signed artifacts; public test scalar 2. No publication. */\nexport const SIGNED_LINK_ARTIFACTS = '+JSON.stringify(rows)+' as const;\n');
console.log(JSON.stringify(rows.map(({role,appId,event,htmlHash})=>({role,appId,eventId:event.id,publisher:event.pubkey,htmlHash}))));
