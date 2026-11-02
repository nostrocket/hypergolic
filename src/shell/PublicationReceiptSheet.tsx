import {useRef} from 'react';
import {AccessibilityInfo,Modal,ScrollView,StyleSheet,Text,View} from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {OutboxPublicationReceipt} from '../outbox/publication-receipt';
import type {RelayOutcome} from '../network/relay-service';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
function Group({title,id,rows}:{title:string;id:string;rows:readonly RelayOutcome[]}){
  const { styles } = useShellStyles(createStyles);
 return <View style={styles.group}><Text accessibilityRole="header" style={styles.heading}>{title}</Text><Text selectable style={styles.mono}>{id}</Text>
  {rows.map(row=><View key={row.relay} style={styles.group}><Text selectable style={styles.mono}>{row.relay}</Text><Text style={styles.text}>{row.status==='cancelled-before-send'?'Cancelled before send':row.status==='unknown'?'Unknown':row.status==='accepted'?'Accepted':'Rejected'}{row.reason?` · ${row.reason}`:''}</Text></View>)}
 </View>;
}
/** Primary and existing-list ACKs stay separate; acceptance does not prove recipient consumption. */
export function PublicationReceiptSheet({receipt,onDismiss}:{receipt:OutboxPublicationReceipt;onDismiss:()=>void}){
  const { styles } = useShellStyles(createStyles);
 const insets=useSafeAreaInsets(),heading=useRef<Text>(null);
 return <Modal visible transparent animationType="none" onRequestClose={onDismiss} onShow={()=>{if(heading.current)AccessibilityInfo.sendAccessibilityEvent(heading.current,'focus');}}><View style={styles.backdrop}><View accessibilityViewIsModal style={[styles.sheet,{paddingBottom:Math.max(16,insets.bottom)}]} testID="outbox-publication-receipts">
  <ScrollView contentContainerStyle={styles.scroll}><Text ref={heading} accessibilityRole="header" style={styles.heading}>Publication results</Text><Text accessibilityLiveRegion="polite" style={styles.text}>{receipt.primary.ok?'Primary event accepted.':receipt.response.error}</Text>
   <Group title="Primary event" id={receipt.primary.event.id} rows={receipt.primary.outcomes}/>
   {receipt.ancillary&&<Group title="Existing relay list" id={receipt.ancillary.event.id} rows={receipt.ancillary.outcomes}/>}</ScrollView>
  <Pressable accessibilityRole="button" onPress={onDismiss} style={styles.close}><Text style={styles.closeText}>Close results</Text></Pressable>
 </View></View></Modal>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({backdrop:{flex:1,backgroundColor:'#000000b3',justifyContent:'flex-end'},sheet:{maxHeight:'90%',backgroundColor:colors.surface,paddingTop:24,borderTopLeftRadius:0,borderTopRightRadius:0},scroll:{paddingHorizontal:24,paddingBottom:24,gap:16},group:{gap:8},heading:{ fontFamily: fonts.strong,color:colors.text,fontSize:19,},text:{ fontFamily: fonts.body,color:colors.text,fontSize:15,lineHeight:22},mono:{ fontFamily: fonts.mono,color:colors.muted,fontSize:12,lineHeight:19},close:{marginHorizontal:24,minHeight:52,justifyContent:'center',alignItems:'center',backgroundColor: colors.primary,borderRadius:0},closeText:{ textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong,color: colors.onPrimary,fontSize: 14,}});
