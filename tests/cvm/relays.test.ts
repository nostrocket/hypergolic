import test from 'node:test';import assert from 'node:assert/strict';
import {withCvmRelayDefaults} from '../../src/cvm/cvm-relay-defaults.ts';
import type {NativeRelaySettings} from '../../src/network/relay-settings-native.ts';
test('future CVM defaults follow only completed trusted Settings writes and remain bounded to four',async()=>{
 let snapshot={networkRelays:['wss://first.test'],lookupRelays:['wss://lookup.test']};let release!:()=>void;
 const settings:NativeRelaySettings={getSettings:()=>snapshot,async addRelay(_role,url){await new Promise<void>(resolve=>{release=resolve;});snapshot={...snapshot,networkRelays:[...snapshot.networkRelays,url]};return snapshot;},async removeRelay(){throw Error('persistence failed');},async restoreDefaults(){return{networkRelays:['a','b','c','d','e'],lookupRelays:[]};},async close(){}};
 const current:string[][]=[];const mirrored=withCvmRelayDefaults(settings,rows=>current.push([...rows]));
 const write=mirrored.addRelay('network','wss://second.test');assert.deepEqual(current,[['wss://first.test']]);release();await write;assert.deepEqual(current[1],['wss://first.test','wss://second.test']);
 await assert.rejects(mirrored.removeRelay('network','wss://first.test'));assert.equal(current.length,2);await mirrored.restoreDefaults();assert.deepEqual(current[2],['a','b','c','d']);
 assert.deepEqual(snapshot.networkRelays,['wss://first.test','wss://second.test']);
});
