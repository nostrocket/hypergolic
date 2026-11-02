import { updateFixturePublisherAppState } from './fixture-publisher-lifecycle';
import {useEffect, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, AppState, StyleSheet, Text, View} from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { ShellTextInput as TextInput } from './ShellTextInput';
import type {FixturePublisher} from '../fixture-release/publisher';
import {BUNDLED_FIXTURES} from '../runtime/bundled-catalog';
import destinations from '../config/fixture-release.json';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

export function FixturePublisherLab({service,format}: {service: FixturePublisher;format(pubkey:string):string}) {
  const { styles, colors } = useShellStyles(createStyles);
  const state=useSyncExternalStore(service.subscribe,service.getSnapshot);
  const [server,setServer]=useState(destinations.server);
  const [relays,setRelays]=useState(()=>destinations.relays.join('\n'));
  useEffect(()=>{
    updateFixturePublisherAppState(service, AppState.currentState);
    const listener=AppState.addEventListener('change',next=>updateFixturePublisherAppState(service,next));
    return ()=>{listener.remove();service.cancel();};
  },[service]);
  const busy=['preparing','uploading','publishing'].includes(state.phase);
  const action=(label:string,id:string,onPress:()=>void)=><Pressable accessibilityRole="button" testID={id} disabled={busy}
    accessibilityState={{disabled:busy}} style={styles.action} onPress={onPress}><Text style={styles.actionText}>{label}</Text></Pressable>;
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>Publish test napplets</Text>
    <Text style={styles.detail}>The selected identity will become the public author. Each exact HTML upload and signed manifest needs separate approval.</Text>
    {state.phase==='idle' && <>
      <Text style={styles.detail}>Blossom server</Text>
      <TextInput testID="fixture-release-server" accessibilityLabel="Fixture upload server" value={server} onChangeText={setServer}
        autoCapitalize="none" autoCorrect={false} maxLength={2048} style={styles.input}/>
      <Text style={styles.detail}>Manifest relays, one per line</Text>
      <TextInput testID="fixture-release-relays" accessibilityLabel="Fixture manifest relays" value={relays} onChangeText={setRelays}
        autoCapitalize="none" autoCorrect={false} maxLength={16*1024} multiline style={styles.input}/>
      {Object.keys(BUNDLED_FIXTURES).flatMap(fixture => ['nap-support','approval-lab-v1','approval-lab-v2', 'approval-lab-v3','feed-lab-v1'].includes(fixture) ? [] : [<View key={fixture}>
        {action(`Review ${fixture}`,`fixture-release-prepare-${fixture}`,()=>{void service.prepare(fixture,server,relays.split(/\s+/).filter(Boolean));})}
      </View>])}
    </>}
    {busy && <ActivityIndicator color={colors.accent}/>}
    {state.review && <View style={styles.group}>
      <Text style={styles.title}>{state.review.fixture}</Text>
      <Text selectable testID="fixture-release-identity" style={styles.mono}>{format(state.review.identity)}</Text>
      <Text selectable testID="fixture-release-details" style={styles.mono}>{`${state.review.server}\ntext/html · ${state.review.size} bytes\nSHA-256 ${state.review.sha256}\nRelays:\n${state.review.relays.join('\n')}`}</Text>
      {state.review.event && <Text selectable testID="fixture-release-event" style={styles.mono}>{JSON.stringify({eventId:state.review.event.hash,event:state.review.event.event},null,2)}</Text>}
    </View>}
    {state.phase==='upload-review' && state.review && action('Approve exact HTML upload','fixture-release-approve-upload',()=>{if(state.review)void service.approveUpload(state.review);})}
    {state.phase==='manifest-review' && state.review && action('Approve public manifest','fixture-release-approve-manifest',()=>{if(state.review)void service.approveManifest(state.review);})}
    {state.result!=='' && <Text selectable testID="fixture-release-result" accessibilityLiveRegion="polite" style={styles.mono}>{state.result}</Text>}
    {state.phase!=='idle' && <Pressable accessibilityRole="button" testID="fixture-release-cancel" onPress={()=>service.cancel()} style={styles.action}>
      <Text style={styles.actionText}>{busy?'Cancel':'Close release review'}</Text></Pressable>}
  </View>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({group:{gap:16},title:{ fontFamily: fonts.display,color:colors.text,fontSize: 28,},detail:{ fontFamily: fonts.body,color:colors.muted,fontSize:16,lineHeight:24},
  mono:{ fontFamily: fonts.mono,color:colors.text,fontSize:13,lineHeight:20},input:{color:colors.text,borderWidth:1,borderColor:colors.border,borderRadius:0,padding:16,minHeight:56},
  action:{backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border,borderRadius:0,padding:18,minHeight:56},actionText:{ textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong,color:colors.text,fontSize: 14}});
