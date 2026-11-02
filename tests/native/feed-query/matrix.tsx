import { requireNativeView } from 'expo';
import * as SQLite from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { createNativeRelayQuery } from '../../../src/network/native-relay-query';
import { createCapabilityBroker, type NativeCapabilityPort } from '../../../src/runtime/capability-broker';
import { loadNativeCapabilityPort } from '../../../src/runtime/native-capability-port';
import { BUNDLED_FIXTURES } from '../../../src/runtime/bundled-catalog';
import { openShellDatabase } from '../../../src/storage/database';
import type { NativeRegistration } from '../../../src/runtime/capability-protocol';
import type { NativeCapabilityEvent } from '../../../src/runtime/runtime-owner';
import events from './events.json';

type HostEvent = NativeCapabilityEvent | {type:'ready'|'error';sessionId:string};
const Host = requireNativeView<ViewProps & {configuration:string;active:boolean;onHostEvent:(event:NativeSyntheticEvent<HostEvent>)=>void}>('HypergolicNappletHost');
export const CASES = ['signed', 'empty', 'bad-signature', 'wrong-filter', 'missing-eose', 'event-flood', 'frame-flood', 'timeout', 'close', 'owner-epoch'] as const;
const config = Object.freeze({sessionId:'feed-query-matrix',epoch:0,
  user:'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',publisher:'f'.repeat(64),
  appId:'feed-lab',version:BUNDLED_FIXTURES['feed-lab'].aggregateHash,instanceId:'feed-query-matrix',fixture:'feed-lab',domains:['identity','relay','theme']});
/** Diagnostic frames only; SDK, Kehto, native leases, production broker and validators remain real. */
export function QueryMatrix() {
  const [index,setIndex]=useState(0),[prepared,setPrepared]=useState(false),[visible,setVisible]=useState(true),[receipt,setReceipt]=useState('Waiting for SDK query');
  const receiver=useRef<((event:HostEvent)=>void)|null>(null);
  const scenario=CASES[index]!;
  useEffect(()=> {
    let mounted=true,ownerActive=true,broker:ReturnType<typeof createCapabilityBroker>|null=null,closeDatabase:(()=>Promise<void>)|null=null;
    const timers:ReturnType<typeof setTimeout>[]=[];
    const later=(work:()=>void,ms:number)=>{timers.push(setTimeout(work,ms));};
    let calls=0,cancelled=0,lateFrames=0,delivered=0,denied=0,finished=0;
    const queryTokens=new Set<string>();
    const operations=new Set<string>();
    const base=loadNativeCapabilityPort();
    const observed:NativeCapabilityPort={
      take(token){const raw=base.take(token);if(raw&&JSON.parse(JSON.parse(raw).request).type==='relay.query')queryTokens.add(token);return raw;},
      isActive:base.isActive,
      finish(token,response){if(queryTokens.has(token)){finished++;if(response===null)denied++;else delivered++;}base.finish(token,response);},
    };
    const frames=(sub:string)=> {
      const event=(value:unknown)=>JSON.stringify(['EVENT',sub,value]),eose=JSON.stringify(['EOSE',sub]);
      if(scenario==='empty')return [eose];
      if(scenario==='bad-signature')return [event({...events[0],sig:'0'.repeat(128)}),eose];
      if(scenario==='wrong-filter')return [event(events[1]),eose];
      if(scenario==='missing-eose')return [event(events[0])];
      if(scenario==='event-flood')return [...Array.from({length:33},()=>event(events[0])),eose];
      if(scenario==='frame-flood')return [...Array.from({length:64},()=>JSON.stringify(['NOTICE','fixture'])),eose];
      return [event(events[0]),eose];
    };
    const queries=createNativeRelayQuery({newInstanceId:base.newInstanceId,
      cancelPublishedRelay(id){if(!operations.delete(id))throw new Error('Wrong operation cancelled');cancelled++;},
      async queryPublishedRelay(id,_url,_wire,sub){
        calls++;operations.add(id);
        if(scenario==='timeout'||scenario==='close'||scenario==='owner-epoch')return new Promise<string[]>(resolve=> {
          if(scenario!=='timeout')later(()=>{ownerActive=false;if(scenario==='close'){broker?.revoke();setVisible(false);}},40);
          later(()=>{lateFrames++;resolve(frames(sub));},220);
        });
        return frames(sub);
      },
    },()=>['wss://relay.example.org'],120);
    void openShellDatabase(SQLite,Platform.OS==='ios'?'ios':'android').then(database=> {
      if(!mounted){void database.close();return;}
      closeDatabase=()=>database.close();
      let generation:string|null=null;
      receiver.current=event=> {
        if(event.type!=='capability'||event.sessionId!==config.sessionId||event.lane!==undefined)return;
        if(generation===null){generation=event.generation;broker=createCapabilityBroker(database,observed,{registration:{...config,generation} as NativeRegistration,
          assertActive(){if(!ownerActive||!mounted)throw new Error('Owner epoch revoked');}},queries);}
        if(event.generation!==generation)return;
        void broker!.dispatch(event.token).then(()=> {
          if(!mounted||!queryTokens.has(event.token))return;
          later(()=> {
            const delayed=scenario==='timeout'||scenario==='close'||scenario==='owner-epoch';
            const revoked=scenario==='close'||scenario==='owner-epoch';
            const valid=calls===1&&finished===1&&cancelled===(delayed?1:0)&&lateFrames===(delayed?1:0)&&delivered===(revoked?0:1)&&denied===(revoked?1:0);
            setReceipt(`${valid?'PASS':'FAIL'} ${scenario}: calls ${calls}, cancel ${cancelled}, late ${lateFrames}, replies ${delivered}, denied ${denied}`);
          },300);
        });
      };
      setVisible(true);setPrepared(true);setReceipt('Waiting for SDK query');
    }).catch(()=>setReceipt('FAIL database unavailable'));
    return()=>{mounted=false;ownerActive=false;broker?.revoke();receiver.current=null;timers.forEach(clearTimeout);void closeDatabase?.();};
  },[scenario]);
  const next=()=>{setPrepared(false);setVisible(false);setIndex(value=>value+1);};
  return <View style={styles.root}>
    <Text style={styles.text}>Controlled query · {scenario}</Text>
    <Text style={styles.text} testID="query-matrix-receipt">{receipt}</Text>
    {index<CASES.length-1?<Pressable accessibilityRole="button" style={styles.button} onPress={next}><Text style={styles.text}>Next query case</Text></Pressable>:null}
    {prepared&&visible?<Host key={scenario} configuration={JSON.stringify(config)} active onHostEvent={event=>receiver.current?.(event.nativeEvent)} style={styles.host}/>:null}
  </View>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},host:{flex:1},text:{color:'#f3efeb',fontSize:14,padding:8,textAlign:'center'},button:{minHeight:48,backgroundColor:'#34251d',justifyContent:'center'}});
