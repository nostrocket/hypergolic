import {registerRootComponent, requireNativeView, requireNativeModule} from 'expo';
import * as SQLite from 'expo-sqlite';
import {useEffect, useRef, useState} from 'react';
import {Platform, Pressable, StyleSheet, Text, View, type NativeSyntheticEvent, type ViewProps} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {loadNativeRelayStreamPort,attachNativeRelayLifecycle} from '../../../src/network/native-relay-subscription-port';
import {createOutboxSubscriptions} from '../../../src/outbox/subscriptions';
import {createOutboxSubscriptionBroker} from '../../../src/outbox/subscription-broker';
import {createCapabilityBroker} from '../../../src/runtime/capability-broker';
import {loadNativeCapabilityPort} from '../../../src/runtime/native-capability-port';
import {createNativeRelayQuery} from '../../../src/network/native-relay-query';
import {openOutboxRelayListCache} from '../../../src/outbox/relay-list-cache';
import {createOutboxAuthorResolver} from '../../../src/outbox/author-resolver';
import {createOutboxReadService} from '../../../src/outbox/read-service';
import type {NativePublishedRelayPort} from '../../../src/napplets/native-published-relay';
import {BUNDLED_FIXTURES} from '../../../src/runtime/bundled-catalog';
import {openShellDatabase} from '../../../src/storage/database';
import type {NativeRegistration} from '../../../src/runtime/capability-protocol';
import type {NativeCapabilityEvent} from '../../../src/runtime/runtime-owner';

type HostEvent = NativeCapabilityEvent | {type:'ready'|'error';sessionId:string};
const Host = requireNativeView<ViewProps & {configuration:string;active:boolean;onHostEvent:(event:NativeSyntheticEvent<HostEvent>)=>void}>('HypergolicNappletHost');
const baseConfig = Object.freeze({sessionId:'outbox-query-native',epoch:0,
  user:'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',publisher:'f'.repeat(64),
  appId:'feed-lab',version:BUNDLED_FIXTURES['feed-lab'].aggregateHash,instanceId:'outbox-query-native',fixture:'feed-lab',domains:['identity','outbox','relay','theme']});
/** Genuine SDK/native/WSS tracer. Public test identity only; no signer or publication. */
const deniedConfig = Object.freeze({...baseConfig,domains:['identity','relay','theme']});
const otherConfig=Object.freeze({...baseConfig,user:'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',epoch:1});
type CaseName = 'normal'|'missing-domain'|'owner-mismatch'|'other-identity';
function Fixture({caseName,selected}:{caseName:CaseName;selected:boolean}) {
  const config = caseName === 'missing-domain' ? deniedConfig : caseName==='other-identity'?otherConfig:baseConfig;
  const [prepared,setPrepared]=useState(false),[status,setStatus]=useState('Preparing Outbox fixture');
  const [trace,setTrace]=useState('{}');
  const receiver=useRef<((event:HostEvent)=>void)|null>(null);
  useEffect(()=> {
    let streams:ReturnType<typeof createOutboxSubscriptionBroker>|null=null,streamManager:ReturnType<typeof createOutboxSubscriptions>|null=null,detach:(()=>void)|null=null;
    let live=true,broker:ReturnType<typeof createCapabilityBroker>|null=null,generation:string|null=null;
    let database:Awaited<ReturnType<typeof openShellDatabase>>|null=null,cache:Awaited<ReturnType<typeof openOutboxRelayListCache>>|null=null;
    const capability=loadNativeCapabilityPort(),native=requireNativeModule<NativePublishedRelayPort>('HypergolicNappletHost');
    const platform=Platform.OS==='ios'?'ios':'android';
    const close=()=> {
      const selectedDatabase=database,selectedCache=cache;database=null;cache=null;
      void selectedDatabase?.close().catch(()=>console.warn('Fixture database close failed'));
      void selectedCache?.close().catch(()=>console.warn('Fixture cache close failed'));
    };
    const setup=async()=> {
      database=await openShellDatabase(SQLite,platform);
      cache=await openOutboxRelayListCache(SQLite,platform);
      if(!live) return;
      const calls:{role:string;relay:string}[]=[];
      const observed=(role:string)=>({...native,newInstanceId:()=>native.newInstanceId(),cancelPublishedRelay:(id:string)=>native.cancelPublishedRelay(id),
        queryPublishedRelay:(id:string,relay:string,wire:string,sub:string)=>{calls.push({role,relay});setTrace(JSON.stringify({calls}));return native.queryPublishedRelay(id,relay,wire,sub);}});
      const discovery=createNativeRelayQuery(observed('discovery'),()=>['wss://nos.lol']);
      const resolver=createOutboxAuthorResolver(cache,discovery);
      const read=createOutboxReadService(resolver,observed('data'),()=>({networkRelays:['wss://relay.mostro.network'],lookupRelays:['wss://nos.lol']}));
      const streamTrace:{opens:{id:string;relay:string;at:number}[];stops:string[];eose:string[];plans:unknown[];calls:typeof calls}={opens:[],stops:[],eose:[],plans:[],calls};
      const update=()=>setTrace(JSON.stringify({stream:streamTrace}));
      const outbox={...read,async plan(...args:Parameters<typeof read.plan>){const plan=await read.plan(...args);streamTrace.plans.push({plan,refresh:args[4]===true,at:Date.now()});update();return plan;},async getEvent(...args:Parameters<typeof read.getEvent>){calls.length=0;const result=await read.getEvent(...args);setTrace(JSON.stringify({calls,result}));return result;},async resolveRelays(...args:Parameters<typeof read.resolveRelays>){calls.length=0;const plan=await read.resolveRelays(...args);setTrace(JSON.stringify({calls,plan}));return plan;},async query(...args:Parameters<typeof read.query>){calls.length=0;const result=await read.query(...args);setTrace(JSON.stringify({calls,plan:result.plan,incomplete:result.incomplete}));return result;}};
      const socket=loadNativeRelayStreamPort();
      streamManager=createOutboxSubscriptions({...socket,open(id,url,wire,sub,frame,failed,token){streamTrace.opens.push({id,relay:url,at:Date.now()});update();const stop=socket.open(id,url,wire,sub,text=>{const value=JSON.parse(text);if(value[0]==='EOSE'){streamTrace.eose.push(id);update();}frame(text);},failed,token);return()=>{streamTrace.stops.push(id);update();stop();};}},outbox);
      detach=attachNativeRelayLifecycle(streamManager);
      receiver.current=event=> {
        if(event.type!=='capability'){if(event.type==='error')broker?.revoke();setStatus(event.type==='ready'?'Native Outbox host connected':'Native Outbox host failed');return;}
        if(event.sessionId!==config.sessionId||event.lane!==undefined&&event.lane!=='outbox-subscription')return;
        if(generation===null){generation=event.generation;const owner={registration:{...config,generation,publisher:caseName==='owner-mismatch'?'e'.repeat(64):config.publisher} as NativeRegistration,assertActive(){if(!live)throw Error('fixture revoked');}};if(config.domains.includes('outbox'))streams=createOutboxSubscriptionBroker(capability.subscriptions!,streamManager!,owner);broker=createCapabilityBroker(database!,capability,owner,undefined,undefined,undefined,undefined,outbox,request=>streams?.close(request));}
        if(event.generation===generation){if(event.lane==='outbox-subscription')streams?.dispatch(event.token);else void broker!.dispatch(event.token);}
      };
      setPrepared(true);setStatus('Outbox fixture ready · Lookup nos.lol · Network mostro');
    };
    void setup().catch(()=>{if(live)setStatus('Outbox fixture unavailable');}).finally(()=>{if(!live)close();});
    return()=>{live=false;broker?.revoke();streams?.revoke();detach?.();streamManager?.revokeAll();receiver.current=null;close();};
  },[config,caseName]);
  return <View style={styles.root}><Text style={styles.notice}>Public read-only Outbox fixture · no signing</Text><Text testID="outbox-native-status" style={styles.notice}>{status}</Text>
    <Text numberOfLines={5} accessibilityLabel={trace} testID="outbox-native-trace" style={styles.notice}>{trace}</Text>
    {prepared?<Host configuration={JSON.stringify(config)} active={selected} onHostEvent={event=>receiver.current?.(event.nativeEvent)} style={styles.host}/>:null}</View>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},host:{flex:1},notice:{color:'#f3efeb',fontSize:12,padding:8,textAlign:'center'}});
function Root(){const [caseName,setCase]=useState<CaseName>('normal'),[selected,setSelected]=useState(true);
  return <SafeAreaProvider><SafeAreaView style={styles.root}><View style={{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-around'}}>
    <Pressable accessibilityRole="button" onPress={()=>setCase('missing-domain')}><Text style={styles.notice}>Without Outbox grant</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={()=>setCase('owner-mismatch')}><Text style={styles.notice}>Mismatched owner</Text></Pressable>
  <Pressable accessibilityRole="button" onPress={()=>setSelected(value=>!value)}><Text style={styles.notice}>{selected?'Switch loaded napplet':'Return to Outbox'}</Text></Pressable><Pressable accessibilityRole="button" onPress={()=>setCase('other-identity')}><Text style={styles.notice}>Change public identity</Text></Pressable></View><View collapsable={false} style={[styles.root,!selected&&{opacity:0}]} pointerEvents={selected?'auto':'none'} accessibilityElementsHidden={!selected} importantForAccessibility={selected?'auto':'no-hide-descendants'}><Fixture key={caseName} caseName={caseName} selected={selected}/></View></SafeAreaView></SafeAreaProvider>;}

registerRootComponent(Root);
