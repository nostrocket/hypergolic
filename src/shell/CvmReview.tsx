import {useEffect,useSyncExternalStore,useRef} from 'react';
import {AppState,ScrollView,StyleSheet,Text,View,type ViewInstance} from 'react-native';
import {ShellModal} from './ShellModal';import {ShellPressable} from './ShellPressable';import {TrustedBand} from './TrustedBand';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useShellStyles,type ShellPalette,type ShellFonts} from './theme';
import {snapshotEventId} from '../napplets/published-identity';
import type {CvmService} from '../cvm/cvm-service';import type {ReviewSlot} from './review-slot';import type {Workspace} from './workspace';
const emptySubscribe=()=>()=>{},empty=()=>null;
const noCvm=Object.freeze({current:null,pendingSessionIds:Object.freeze([] as string[])}),emptyCvm=()=>noCvm;
export function useCvmPresentation(service:CvmService|undefined,slot:ReviewSlot|undefined){
  const snapshot=useSyncExternalStore(service?.subscribe??emptySubscribe,service?.getSnapshot??emptyCvm);
  const claim=useSyncExternalStore(slot?.subscribe??emptySubscribe,slot?.getSnapshot??empty);
  return{snapshot,shown:Boolean(snapshot.current&&(!slot||claim?.lane==='cvm'&&claim.item.id===snapshot.current.id))};
}
export function CvmReview({service,slot,workspace}:{service:CvmService;slot?:ReviewSlot;workspace?:Workspace}){
  const snapshot=useSyncExternalStore(service.subscribe,service.getSnapshot);
  const selected=useSyncExternalStore(slot?.subscribe??emptySubscribe,slot?.getSnapshot??empty);
  const item=snapshot.current,title=workspace?.sessions.find(row=>row.id===item?.origin.sessionId)?.title??'This napplet';
  const cancel=useRef<ViewInstance>(null),insets=useSafeAreaInsets(),{styles}=useShellStyles(style);
  useEffect(()=>{if(item&&slot&&!selected)slot.reserve('cvm',item);},[item,slot,selected]);
  useEffect(()=>()=>{if(item&&slot)slot.release('cvm',item.id);},[item,slot]);
  useEffect(()=>{const state=AppState.addEventListener('change',value=>{if(value!=='active')service.pause();});return()=>{state.remove();};},[service]);
  const shown=item&&(!slot||selected?.lane==='cvm'&&selected.item.id===item.id)?item:null;
  if(!shown)return null;
  const review=shown.review,method=review.message.method??'Send response';
  const manifestEventId=snapshotEventId(review.scope.appId);
  return <ShellModal visible transparent animationType="none" onShow={()=>cancel.current?.focus()} onRequestClose={()=>service.decide(shown.id,false)}>
    <View style={[styles.backdrop,{paddingLeft:insets.left,paddingRight:insets.right,paddingBottom:insets.bottom}]}>
      <View accessibilityViewIsModal testID="cvm-review" style={styles.sheet}>
        <TrustedBand/><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={styles.title}>Send a provider request</Text>
          <Text style={styles.text}>{title} can keep this request running while you use another napplet. It stops when Hypergolic goes into the background, your account changes, or you close this napplet.</Text>
          <Text style={styles.text}>Time limit: {Math.ceil(review.options.timeoutMs / 1000)} seconds, including time spent on this review. Payments through Hypergolic are unavailable. Provider tools may have external effects.</Text>
          <Text style={styles.label}>Requesting napplet</Text><Text selectable style={styles.text}>{title}</Text>
          {manifestEventId && <><Text style={styles.label}>Snapshot (kind 5129)</Text><Text selectable style={styles.mono}>{manifestEventId}</Text></>}
          <Text style={styles.label}>Publisher and exact version</Text><Text selectable style={styles.mono}>{review.scope.publisher}{'\n'}{review.scope.version}</Text>
          <Text style={styles.label}>Provider</Text><Text testID="cvm-review-provider" selectable style={styles.mono}>{review.server.pubkey}</Text>
          <Text style={styles.label}>Operation</Text><Text style={styles.text}>{method}</Text>
          <Text style={styles.label}>Exact request</Text><Text testID="cvm-review-request" selectable style={styles.mono}>{JSON.stringify(review.message,null,2)}</Text>
          <Text style={styles.label}>Relay</Text><Text selectable style={styles.mono}>{review.server.relays?.join('\n')}</Text>
        </ScrollView>
        <View style={styles.actions}>
          <ShellPressable ref={cancel} testID="cvm-review-cancel" accessibilityRole="button" onPress={()=>service.decide(shown.id,false)} style={styles.cancel}><Text style={styles.text}>Cancel</Text></ShellPressable>
          <ShellPressable testID="cvm-review-send" accessibilityRole="button" onPress={()=>service.decide(shown.id,true)} style={styles.send}><Text style={styles.sendText}>{review.message.method?'Send request':'Send response'}</Text></ShellPressable>
        </View>
      </View>
    </View>
  </ShellModal>;
}
const style=(colors:ShellPalette,fonts:ShellFonts)=>StyleSheet.create({
  backdrop:{flex:1,backgroundColor:colors.background,justifyContent:'center'},sheet:{maxHeight:'100%',backgroundColor:colors.surface},
  content:{padding:24,gap:12},title:{fontFamily:fonts.display,fontSize:25,color:colors.text},text:{fontFamily:fonts.body,fontSize:16,lineHeight:23,color:colors.text},
  label:{fontFamily:fonts.strong,fontSize:14,color:colors.muted,marginTop:8},mono:{fontFamily:fonts.mono,fontSize:13,lineHeight:20,color:colors.text},
  actions:{flexDirection:'row',padding:16,gap:12},cancel:{minHeight:52,flex:1,alignItems:'center',justifyContent:'center',borderColor:colors.border,borderWidth:1},
  send:{minHeight:52,flex:1,alignItems:'center',justifyContent:'center',backgroundColor:colors.primary},sendText:{fontFamily:fonts.strong,color:colors.onPrimary,fontSize:16},
});
