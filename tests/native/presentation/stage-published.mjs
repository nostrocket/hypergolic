/** Sign exact Routing Lab bytes with public test scalars 2 and 3; never publish. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {finalizeEvent,verifyEvent} from 'nostr-tools/pure';
import {naddrEncode} from 'nostr-tools/nip19';
const root=new URL('../../../',import.meta.url),secret=new Uint8Array(32);secret[31]=2;
const hash=value=>createHash('sha256').update(value).digest('hex');
const html=await readFile(new URL('runtime/fixtures/routing-lab.html',root),'utf8'),htmlHash=hash(html),aggregate=hash(htmlHash+' /index.html\n');
const rows=[['caller',['notify']],['peer',['notify']],['no-notify',['theme']],['config-caller',['config']],['config-peer',['config']],['no-config',['theme']]].map(([role,domains])=>{
 const appId=(role.startsWith('config-') ? 'signed-' : 'signed-notify-')+role+'-lab';
 const event=finalizeEvent({kind:35129,created_at:1791079200,content:'',tags:[['d',appId],['path','/index.html',htmlHash],['x',aggregate,'aggregate'],...domains.map(domain=>['requires',domain])]},secret);
 return {role,appId,event,address:naddrEncode({kind:35129,pubkey:event.pubkey,identifier:appId}),htmlHash,html};
});
const original = rows.find(row => row.role === 'config-caller'), updatedHtml = html + '\n<!-- distinct signed configuration version -->\n', updatedHash = hash(updatedHtml), updatedAggregate = hash(updatedHash + ' /index.html\n');
const updatedEvent = finalizeEvent({kind:35129,created_at:1791165600,content:'',tags:[['d',original.appId],['path','/index.html',updatedHash],['x',updatedAggregate,'aggregate'],['requires','config']]},secret);
rows.push({...original,role:'config-update',event:updatedEvent,htmlHash:updatedHash,html:updatedHtml});
const collisionSecret = new Uint8Array(32); collisionSecret[31] = 3;
const notifyOriginal = rows.find(row => row.role === 'caller');
const notifyCollisionEvent = finalizeEvent({kind:35129,created_at:1791079200,content:'',tags:[['d',notifyOriginal.appId],['path','/index.html',htmlHash],['x',aggregate,'aggregate'],['requires','notify']]},collisionSecret);
rows.push({...notifyOriginal,role:'notify-collision',event:notifyCollisionEvent,address:naddrEncode({kind:35129,pubkey:notifyCollisionEvent.pubkey,identifier:notifyOriginal.appId})});
const collisionEvent = finalizeEvent({kind:35129,created_at:1791079200,content:'',tags:[['d',original.appId],['path','/index.html',htmlHash],['x',aggregate,'aggregate'],['requires','config']]},collisionSecret);
rows.push({...original,role:'config-collision',event:collisionEvent,address:naddrEncode({kind:35129,pubkey:collisionEvent.pubkey,identifier:original.appId})});
const integerField = 'count:{type:"integer",title:"Item count",minimum:1,maximum:12,default:3';
if (html.split(integerField).length !== 2) throw new Error('Expected one exact original configuration integer field');
const incompatibleHtml = html.replace(integerField, 'count:{type:"string",title:"Item count",enum:["fresh-version","other-version"],default:"fresh-version"');
const incompatibleHash = hash(incompatibleHtml), incompatibleAggregate = hash(incompatibleHash+' /index.html\n');
const incompatibleEvent = finalizeEvent({kind:35129,created_at:1791252000,content:'',tags:[['d',original.appId],['path','/index.html',incompatibleHash],['x',incompatibleAggregate,'aggregate'],['requires','config']]},secret);
rows.push({...original,role:'config-incompatible-update',event:incompatibleEvent,htmlHash:incompatibleHash,html:incompatibleHtml});
const notificationUpdateHtml = html + '\n<!-- distinct signed notification version -->\n';
const notificationUpdateHash = hash(notificationUpdateHtml), notificationUpdateAggregate = hash(notificationUpdateHash+' /index.html\n');
const notificationUpdateEvent = finalizeEvent({kind:35129,created_at:1791165600,content:'',tags:[['d',notifyOriginal.appId],['path','/index.html',notificationUpdateHash],['x',notificationUpdateAggregate,'aggregate'],['requires','notify']]},secret);
rows.push({...notifyOriginal,role:'notify-update',event:notificationUpdateEvent,htmlHash:notificationUpdateHash,html:notificationUpdateHtml});
// Keep existing valid signatures byte-stable when all signed inputs are unchanged.
let previous=[];
try { previous=JSON.parse((await readFile(new URL('tests/native/presentation/published-fixture.ts',root),'utf8')).split(' = ')[1].split(' as const;')[0]); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (let index=0; index<rows.length; index++) {
 const row=rows[index], old=previous.find(candidate=>candidate.role===row.role);
 if (!old) continue;
 const signedInputs=({kind,created_at,content,tags,pubkey,id})=>JSON.stringify({kind,created_at,content,tags,pubkey,id});
 if (signedInputs(old.event)===signedInputs(row.event) && old.html===row.html && old.htmlHash===row.htmlHash && old.appId===row.appId && old.address===row.address && verifyEvent(old.event)) rows[index]=old;
}
await writeFile(new URL('tests/native/presentation/published-fixture.ts',root),'/** Generated local signed artifacts; public test scalars 2 and 3. No publication. */\nexport const SIGNED_PRESENTATION_ARTIFACTS = '+JSON.stringify(rows)+' as const;\n');
console.log(JSON.stringify(rows.map(({role,appId,event,htmlHash})=>({role,appId,eventId:event.id,publisher:event.pubkey,htmlHash}))));
