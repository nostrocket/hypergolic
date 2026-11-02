import { useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { ShellTextInput as TextInput } from './ShellTextInput';
import type { ResourceSettings as ResourceSettingsPort } from '../resources/resource-settings.ts';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
export function ResourceSettings({service}:{service:ResourceSettingsPort|null}) {
  const { styles } = useShellStyles(createStyles);
  const [input,setInput] = useState(() => service?.servers().join('\n') ?? '');
  const [status,setStatus] = useState(''), [busy,setBusy] = useState(false);
  const update = async (defaults:boolean) => {
    if (!service || busy) return;
    Keyboard.dismiss();setBusy(true);setStatus('');
    try {
      if (defaults) await service.restoreDefaults(); else await service.replace(input.split('\n').map(value=>value.trim()).filter(Boolean));
      setInput(service.servers().join('\n'));setStatus('Download servers saved.');
    } catch {setStatus('Enter up to four different public HTTPS origins, one per line. Paths and private hosts are blocked.');}
    finally {setBusy(false);}
  };
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.heading}>Blossom downloads</Text>
    <Text style={styles.detail}>The shell tries these servers in order and verifies each file’s SHA-256. These device settings apply to all identities. Clearing the list disables Blossom downloads.</Text>
    {service ? <>
      <TextInput accessibilityLabel="Blossom download servers" testID="resource-servers" value={input} onChangeText={setInput} multiline
        editable={!busy} autoCapitalize="none" autoCorrect={false} style={styles.input} />
      <Pressable accessibilityRole="button" testID="resource-servers-save" disabled={busy} onPress={()=>{void update(false);}} style={styles.button}><Text style={styles.label}>Save download servers</Text></Pressable>
      <Pressable accessibilityRole="button" testID="resource-servers-defaults" disabled={busy} onPress={()=>{void update(true);}} style={styles.button}><Text style={styles.label}>Restore download defaults</Text></Pressable>
      {status && <Text accessibilityLiveRegion="polite" testID="resource-settings-status" style={styles.detail}>{status}</Text>}
    </> : <Text style={styles.detail}>Download settings are unavailable.</Text>}
  </View>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({section:{gap:14},heading:{ fontFamily: fonts.display,color:colors.text,fontSize: 28,},detail:{ fontFamily: fonts.body,color:colors.muted,fontSize:15,lineHeight:22},
  input:{ fontFamily: fonts.body,color:colors.text,borderWidth:1,borderColor:colors.border,borderRadius:0,minHeight:110,padding:14,fontSize:14},
  button:{minHeight:52,padding:15,borderRadius:0,alignItems:'center',backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border},label:{ textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: fonts.mono,color:colors.text,fontSize: 12,}});
