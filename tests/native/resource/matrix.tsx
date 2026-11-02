import { requireNativeView } from 'expo';
import * as SQLite from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { createCapabilityBroker, type NativeCapabilityPort } from '../../../src/runtime/capability-broker';
import { decodeNativeRequest, type NativeRegistration } from '../../../src/runtime/capability-protocol';
import { loadNativeCapabilityPort } from '../../../src/runtime/native-capability-port';
import { createResourceService } from '../../../src/resources/resource-service';
import { createResourceTransfers } from '../../../src/resources/resource-transfers';
import { BUNDLED_FIXTURES } from '../../../src/runtime/bundled-catalog';
import { openShellDatabase } from '../../../src/storage/database';
import type { NativeCapabilityEvent } from '../../../src/runtime/runtime-owner';

type HostEvent = NativeCapabilityEvent | {type:'ready'|'error';sessionId:string};
const Host = requireNativeView<ViewProps & {configuration:string;active:boolean;onHostEvent:(event:NativeSyntheticEvent<HostEvent>)=>void}>('HypergolicNappletHost');
export const RESOURCE_CASES = ['cancel','owner-epoch','close','background','chunk-cancel','chunk-owner-epoch','chunk-close'] as const;
const config = Object.freeze({sessionId:'resource-matrix',epoch:0,
  user:'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',publisher:'f'.repeat(64),
  appId:'resource-lab',version:BUNDLED_FIXTURES['resource-lab'].aggregateHash,instanceId:'resource-matrix',fixture:'resource-lab',domains:['resource','link','theme']});
/** Held resolver/dispatch diagnostics. Real SDK, WebView, leases, broker and byte carrier; no DNS/TLS claim. */
export function ResourceMatrix() {
  const [index,setIndex]=useState(0),[prepared,setPrepared]=useState(false),[visible,setVisible]=useState(true),[receipt,setReceipt]=useState('Waiting for SDK resource');
  const receiver=useRef<((event:HostEvent)=>void)|null>(null),release=useRef<(()=>void)|null>(null),revoke=useRef<(()=>void)|null>(null);
  const scenario=RESOURCE_CASES[index]!;
  useEffect(()=> {
    let mounted=true,ownerActive=true,broker:ReturnType<typeof createCapabilityBroker>|null=null,closeDatabase:(()=>Promise<void>)|null=null;
    let resolveHeld:((value:Uint8Array<ArrayBuffer>)=>void)|null=null,heldChunk:string|null=null;
    let calls=0,late=0,staged=0,privateBytes=0,cancelAck=0,cancels=0,denied=0,errors=0;
    const requests=new Map<string,string>(),timers:ReturnType<typeof setTimeout>[]=[];
    const base=loadNativeCapabilityPort();
    const observed:NativeCapabilityPort={
      take(token){const raw=base.take(token);if(raw){const request=decodeNativeRequest(raw).request as {type:string};requests.set(token,request.type);}return raw;},
      isActive:base.isActive,
      finish(token,response){
        const type=requests.get(token);
        if(type==='resource.cancel'){cancels++;if(response!==null)cancelAck++;}
        if(type==='resource.bytes'){if(response===null)denied++;else if(JSON.parse(response).transfer)staged++;else errors++;}
        if(type==='resource.__chunk' && response!==null && typeof JSON.parse(response).base64==='string')privateBytes++;
        base.finish(token,response);
      },
    };
    const body=()=>new TextEncoder().encode('controlled late resource');
    const service=createResourceService({servers:()=>[],sha256:async()=>{throw Error('No Blossom fixture');},https:async()=> {
      calls++;
      if(scenario.startsWith('chunk-'))return body();
      return new Promise(resolve=>{resolveHeld=resolve;setReceipt('Resource probe held');});
    }});
    const report=()=> {
      timers.push(setTimeout(()=> {
        if(!mounted)return;
        const chunk=scenario.startsWith('chunk-'),cancel=scenario.endsWith('cancel');
        const valid=calls===1&&late===1&&cancelAck===0&&(!cancel || cancels>=1)&&staged===(chunk?1:0)&&privateBytes===0&&
          (chunk || (cancel ? denied+errors===1 : denied===1));
        setReceipt(`${valid?'PASS':'FAIL'} ${scenario}: calls ${calls}, late ${late}, staged ${staged}, private ${privateBytes}, cancel ${cancels}, ACK ${cancelAck}, denied ${denied}, errors ${errors}`);
      },500));
    };
    release.current=()=> {
      if(resolveHeld){const resolve=resolveHeld;resolveHeld=null;late++;resolve(body());report();}
      else if(heldChunk){const token=heldChunk;heldChunk=null;late++;void broker?.dispatch(token).then(report);}
    };
    revoke.current=()=>{ownerActive=false;broker?.revoke();if(scenario.endsWith('close'))setVisible(false);setReceipt('Resource owner revoked');};
    void openShellDatabase(SQLite,Platform.OS==='ios'?'ios':'android').then(database=> {
      if(!mounted){void database.close();return;}
      closeDatabase=()=>database.close();let generation:string|null=null;
      receiver.current=event=> {
        if(event.type!=='capability'||event.sessionId!==config.sessionId||event.lane!==undefined)return;
        if(generation===null){generation=event.generation;broker=createCapabilityBroker(database,observed,{registration:{...config,generation} as NativeRegistration,
          assertActive(){if(!ownerActive||!mounted)throw Error('Owner epoch revoked');}},undefined,undefined,{service,transfers:createResourceTransfers(base.newInstanceId)});}
        if(event.generation!==generation)return;
        // Hold before native take; the original native lease and broker perform their own final checks on release.
        if(scenario.startsWith('chunk-') && staged===1 && heldChunk===null && !requests.has(event.token)) {
          heldChunk=event.token;setReceipt('Resource probe held');return;
        }
        void broker!.dispatch(event.token);
      };
      setVisible(true);setPrepared(true);setReceipt('Waiting for SDK resource');
    }).catch(()=>setReceipt('FAIL database unavailable'));
    return()=>{mounted=false;ownerActive=false;broker?.revoke();service.revokeAll();receiver.current=null;release.current=null;revoke.current=null;timers.forEach(clearTimeout);resolveHeld?.(body());void closeDatabase?.();};
  },[scenario]);
  const next=()=>{setPrepared(false);setVisible(false);setIndex(value=>value+1);};
  return <View style={styles.root}>
    <Text style={styles.text}>Controlled resource · {scenario}</Text><Text style={styles.text} testID="resource-matrix-receipt">{receipt}</Text>
    <Pressable accessibilityRole="button" style={styles.button} onPress={()=>release.current?.()}><Text style={styles.text}>Release resource probe</Text></Pressable>
    <Pressable accessibilityRole="button" style={styles.button} onPress={()=>revoke.current?.()}><Text style={styles.text}>Revoke resource owner</Text></Pressable>
    {index<RESOURCE_CASES.length-1?<Pressable accessibilityRole="button" style={styles.button} onPress={next}><Text style={styles.text}>Next resource case</Text></Pressable>:null}
    {prepared&&visible?<Host key={scenario} configuration={JSON.stringify(config)} active onHostEvent={event=>receiver.current?.(event.nativeEvent)} style={styles.host}/>:null}
  </View>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#140f0b'},host:{flex:1},text:{color:'#f3efeb',fontSize:12,padding:6,textAlign:'center'},button:{minHeight:40,backgroundColor:'#34251d',justifyContent:'center'}});
