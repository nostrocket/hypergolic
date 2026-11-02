/** Sign the exact staged SDK fixture bytes with public test scalar 2; never publish. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {naddrEncode} from 'nostr-tools/nip19';
const root=new URL('../../../',import.meta.url),secret=new Uint8Array(32);secret[31]=2;
const hash=value=>createHash('sha256').update(value).digest('hex');
const rows=[];
for(const [role,domains] of [['state',['identity','storage']],['feed',['identity','relay']]]){
 const html=await readFile(new URL('runtime/fixtures/'+role+'-lab.html',root),'utf8');
 const htmlHash=hash(html),aggregate=hash(htmlHash+' /index.html\n'),appId='signed-identity-'+role+'-lab';
 const event=finalizeEvent({kind:35129,created_at:1790946000,content:'',tags:[['d',appId],['path','/index.html',htmlHash],['x',aggregate,'aggregate'],...domains.map(domain=>['requires',domain])]},secret);
 rows.push({role,appId,event,address:naddrEncode({kind:35129,pubkey:event.pubkey,identifier:appId}),htmlHash,html});
}
await writeFile(new URL('tests/native/identity-data/published-fixture.ts',root),'/** Generated signed local SDK artifacts; public test scalar 2. No publication. */\nexport const SIGNED_IDENTITY_ARTIFACTS = '+JSON.stringify(rows)+' as const;\n');
process.stdout.write(JSON.stringify(rows.map(({role,appId,event,htmlHash})=>({role,appId,eventId:event.id,htmlHash})))+'\n');
