import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeNativeRegistration} from '../../src/runtime/capability-protocol.ts';
const base={sessionId:'session',generation:'generation',epoch:7,user:'1'.repeat(64),publisher:'2'.repeat(64),appId:'app',version:'3'.repeat(64),instanceId:'instance',fixture:'published',domains:['media']};
test('live Media is an exact native-only published registration feature; absence remains finite',()=>{
  assert.equal(decodeNativeRegistration(base).mediaProfile,undefined);
  const live=decodeNativeRegistration({...base,mediaProfile:'finite-live-mp3-v1'});
  assert.equal(live.mediaProfile,'finite-live-mp3-v1');assert.ok(Object.isFrozen(live));assert.equal(live.epoch,7);
  for(const mediaProfile of [undefined,null,true,1,'finite-video-v1',{},[]])assert.throws(()=>decodeNativeRegistration({...base,mediaProfile}));
  assert.throws(()=>decodeNativeRegistration({...base,domains:['theme'],mediaProfile:'finite-live-mp3-v1'}));
  assert.throws(()=>decodeNativeRegistration({...base,fixture:'ux-lab',mediaProfile:'finite-live-mp3-v1'}));
});
test('live Media profile composes with independent Common and CVM native features',()=>{
  const input={...base,domains:['common','identity','outbox','cvm','media'],commonProfile:'social-v1',cvmProfile:'free-foreground-v1',mediaProfile:'finite-live-mp3-v1'};
  const decoded=decodeNativeRegistration(input);
  assert.equal(decoded.commonProfile,'social-v1');assert.equal(decoded.cvmProfile,'free-foreground-v1');assert.equal(decoded.mediaProfile,'finite-live-mp3-v1');
  assert.throws(()=>decodeNativeRegistration({...input,domains:input.domains.filter(value=>value!=='media')}));
  assert.throws(()=>decodeNativeRegistration({...input,cvmProfile:'unknown'}));
});
