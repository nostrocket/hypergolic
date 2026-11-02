import test from 'node:test';
import assert from 'node:assert/strict';
import { admitTargets } from './target-probe.mjs';

function row(id='A', generation='00000000-0000-4000-8000-000000000001') {
  return { id, type:'page', url:`https://appassets.androidplatform.net/assets/runtime/index.html?sessionId=${generation}`,
    webSocketDebuggerUrl:`ws://localhost/devtools/page/${id}`, description:'{}' };
}
test('admits exact targets and rewrites transport only to caller-owned localhost forward', () => {
  const rows = admitTargets([row('B','00000000-0000-4000-8000-000000000002'),row()],3210);
  assert.deepEqual(rows.map(r=>r.id), ['A','B']);
  assert.equal(rows[0].ws,'ws://127.0.0.1:3210/devtools/page/A');
});
test('admits the configured UX fixture while preserving its exact native URL', () => {
  const value = row(); value.url += '&fixture=ux-lab';
  assert.equal(admitTargets([value], 3210)[0].url, value.url);
});
for (const [name, edit] of [
  ['wrong origin',r=>r.url=r.url.replace('appassets.androidplatform.net','example.invalid')],
  ['wrong path',r=>r.url=r.url.replace('index.html','other.html')],
  ['missing generation',r=>r.url=r.url.split('?')[0]],
  ['other fixture',r=>r.url+='&fixture=state-lab'],
  ['empty fixture',r=>r.url+='&fixture='],
  ['duplicate fixture',r=>r.url+='&fixture=ux-lab&fixture=ux-lab'],
  ['unknown query',r=>r.url+='&unexpected=true'],
  ['duplicate query',r=>r.url+='&sessionId=other'],
  ['non-native generation',r=>r.url=r.url.replace('00000000-0000-4000-8000-000000000001','ux-lab-1')],
  ['different websocket target',r=>r.webSocketDebuggerUrl='ws://localhost/devtools/page/B'],
  ['unknown executable type',r=>r.type='iframe'],
]) test('rejects '+name,()=>{ const value=row(); edit(value); assert.throws(()=>admitTargets([value],3210)); });
test('rejects duplicated target or generation',()=>{
  assert.throws(()=>admitTargets([row(),row()],3210));
  assert.throws(()=>admitTargets([row(),row('B')],3210));
});
test('empty inventory is an observation, not an automatic scenario pass',()=>assert.deepEqual(admitTargets([],3210),[]));
