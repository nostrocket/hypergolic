// Independent read-only observer. All results stay in a caller-selected private output.
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyEvent} from 'nostr-tools/pure';
const [output,duration='300000']=process.argv.slice(2);
if(!output||!/^\d+$/.test(duration)||Number(duration)<1000||Number(duration)>300000)throw Error('Usage: observe-public.mjs PRIVATE_OUTPUT [1000..300000]');
const result={kind:'independent-public-relay-stream-v1',relay:'wss://nos.lol',startedAt:Date.now(),eoseAt:null,status:'running',events:[]};
const socket=new WebSocket(result.relay);
const save=()=>writeFileSync(output,JSON.stringify(result,null,2)+'\n');
socket.onopen=()=>socket.send(JSON.stringify(['REQ','independent-feed-stream',{kinds:[1],limit:32}]));
socket.onmessage=({data})=>{
  if(typeof data!=='string'||Buffer.byteLength(data)>66*1024)return;
  const frame=JSON.parse(data);
  if(frame[1]!=='independent-feed-stream')return;
  if(frame[0]==='EOSE'){result.eoseAt=Date.now();save();return;}
  if(frame[0]!=='EVENT')return;
  const source=frame[2];
  const event={id:source.id,pubkey:source.pubkey,kind:source.kind,created_at:source.created_at,tags:source.tags,content:source.content,sig:source.sig};
  if(event.kind!==1||typeof event.content!=='string'||!verifyEvent(event))return;
  if(result.events.some(row=>row.id===event.id))return;
  result.events.push({id:event.id,receivedAt:Date.now(),afterEOSE:result.eoseAt!==null,contentSha256:createHash('sha256').update(event.content).digest('hex')});
  if(result.events.length>512)result.events.shift();save();
};
socket.onerror=()=>{result.status='failed';save();};
setTimeout(()=>{result.status=result.status==='failed'?'failed':'stopped';socket.close();save();},Number(duration));
save();
