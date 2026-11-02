import { TrustedBand } from './TrustedBand';
import {useState, useSyncExternalStore} from 'react';
import {AccessibilityInfo, Keyboard, Modal, FlatList, StyleSheet, Text, View} from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { ShellTextInput as TextInput } from './ShellTextInput';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {ConfigBroker, ConfigReview} from '../presentation/config-broker';
import {CONFIG_LIMITS, configSecretFields, type ConfigSchema, type ConfigValue} from '../presentation/config-schema';
import {ShellStorageError} from '../storage/ports';
import {formatNpub} from '../security/public-identity';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
type Field = {path: readonly string[]; schema: ConfigSchema; section: string};
const fieldKey = (path: readonly string[]) => JSON.stringify(path);
const fieldId = (path: readonly string[]) => path.map(encodeURIComponent).join('.');
function read(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const key of path) {if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined; value = (value as Record<string, unknown>)[key];}
  return value;
}
function write(root: Record<string, unknown>, path: readonly string[], value: unknown) {
  let node = root;
  for (const key of path.slice(0, -1)) {if (node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {}; node = node[key] as Record<string, unknown>;}
  node[path[path.length - 1]!] = value;
}
function fields(schema: ConfigSchema, path: readonly string[] = [], section = ''): Field[] {
  const group = schema['x-napplet-section'] ?? section;
  if (schema.type !== 'object' || path.length > 0 && Object.keys(schema.properties ?? {}).length === 0) return [{path, schema, section: group}];
  return Object.entries(schema.properties!).flatMap(([key, child]) => fields(child, [...path, key], group));
}
function Action({label, id, onPress, disabled = false}: {label: string; id: string; onPress(): void; disabled?: boolean}) {
  const { styles } = useShellStyles(createStyles);
  return <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} testID={id} onPress={onPress} style={styles.button}><Text style={styles.action}>{label}</Text></Pressable>;
}
function Editor({service, review}: {service: ConfigBroker; review: ConfigReview}) {
  const { styles } = useShellStyles(createStyles);
  const insets = useSafeAreaInsets(), secretFields = configSecretFields(review.schema), secretPaths = new Set(secretFields.map(field => fieldKey(field.path)));
  const rows = fields(review.schema).sort((left, right) => {
    const group = (left.section === review.section ? '' : left.section).localeCompare(right.section === review.section ? '' : right.section);
    return group || (left.schema['x-napplet-order'] ?? Infinity) - (right.schema['x-napplet-order'] ?? Infinity) || fieldId(left.path).localeCompare(fieldId(right.path));
  });
  const [draft, setDraft] = useState<Record<string, string>>(() => rows.reduce<Record<string, string>>((initial, field) => {
    const key = fieldKey(field.path), value = read(review.ordinary, field.path);
    if (!secretPaths.has(key) && value !== undefined) initial[key] = typeof value === 'string' ? value : JSON.stringify(value);
    return initial;
  }, {})), [secrets, setSecrets] = useState<Record<string, string | null>>({}), [status, setStatus] = useState({busy: false, error: ''});
  const save = async () => {
    Keyboard.dismiss(); setStatus({busy: true, error: ''});
    try {
      const values: Record<string, unknown> = {}, changes: Record<string, ConfigValue | null> = {};
      for (const field of rows) {
        const key = fieldKey(field.path); if (secretPaths.has(key) || !Object.prototype.hasOwnProperty.call(draft, key)) continue;
        const raw = draft[key]!; write(values, field.path, field.schema.type === 'string' ? raw : JSON.parse(raw));
      }
      for (const field of secretFields) {
        const key = fieldKey(field.path); if (!Object.prototype.hasOwnProperty.call(secrets, key)) continue;
        const raw = secrets[key]; changes[key] = raw === null ? null : field.schema.type === 'array' ? JSON.parse(raw!) as ConfigValue : raw!;
      }
      await service.commit(review.id, values, changes);
    } catch (error) {
      if (service.getSnapshot().review?.id !== review.id) return;
      const message = error instanceof ShellStorageError && error.code === 'STORAGE_INDETERMINATE' ? 'The save could not be confirmed. Reopen settings to check stored values before trying again.' : 'Configuration needs valid values. Check required fields, limits and allowed choices.';
      setStatus({busy: false, error: message}); AccessibilityInfo.announceForAccessibility(message);
    }
  };
  const renderField = ({item: field, index}: {item: Field; index: number}) => {
      const key = fieldKey(field.path), id = fieldId(field.path), secret = secretPaths.has(key), value = secret ? secrets[key] ?? '' : draft[key] ?? '', label = field.schema.title ?? field.path.join('.');
      return <View key={key} style={styles.field}>
        {field.section !== '' && (index === 0 || rows[index - 1]!.section !== field.section) && <Text accessibilityRole="header" style={styles.title}>{field.section}</Text>}
        <Text style={styles.title}>{label}</Text>
        {(field.schema.description || field.schema.markdownDescription) && <Text style={styles.detail}>{field.schema.description ?? field.schema.markdownDescription}</Text>}
        {field.schema.format && <Text style={styles.detail}>Format hint: {field.schema.format}</Text>}
        {field.schema.deprecationMessage && <Text style={styles.detail}>{field.schema.deprecationMessage}</Text>}
        {secret ? <>
          <Text style={styles.detail}>{review.secretPresent[key] ? 'A value is saved. Leave this input unchanged to keep it.' : 'No secret value is saved.'}{field.schema.type === 'array' ? ' Enter a JSON array of strings.' : ''}</Text>
          <TextInput testID={'config-secret-' + id} accessibilityLabel={label + ' (secret)'} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" importantForAutofill="no" maxLength={CONFIG_LIMITS.bytes} value={value} onChangeText={text => setSecrets(old => ({...old, [key]: text}))} style={styles.input} returnKeyType="done" onSubmitEditing={Keyboard.dismiss}/>
          <Action id={'config-secret-clear-' + id} label={secrets[key] === null ? 'Value will be cleared on save' : 'Clear saved value'} onPress={() => setSecrets(old => ({...old, [key]: null}))}/>
        </> : field.schema.enum ? field.schema.enum.map((option, choice) => <Action key={choice} id={'config-choice-' + id + '-' + choice} label={(value === (typeof option === 'string' ? option : JSON.stringify(option)) ? 'Selected: ' : '') + (typeof option === 'string' ? option : JSON.stringify(option)) + (field.schema.enumDescriptions?.[choice] ? ' · ' + field.schema.enumDescriptions[choice] : '')} onPress={() => setDraft(old => ({...old, [key]: typeof option === 'string' ? option : JSON.stringify(option)}))}/>) : field.schema.type === 'boolean' ? <>
          <Action id={'config-choice-' + id + '-true'} label={value === 'true' ? 'Selected: On' : 'On'} onPress={() => setDraft(old => ({...old, [key]: 'true'}))}/><Action id={'config-choice-' + id + '-false'} label={value === 'false' ? 'Selected: Off' : 'Off'} onPress={() => setDraft(old => ({...old, [key]: 'false'}))}/>
        </> : <TextInput testID={'config-field-' + id} accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} multiline={field.schema.type === 'array' || field.schema.type === 'object'} maxLength={CONFIG_LIMITS.bytes} value={value} onChangeText={text => setDraft(old => ({...old, [key]: text}))} style={styles.input} returnKeyType="done" onSubmitEditing={Keyboard.dismiss}/>}
        {!secret && <Action id={'config-reset-' + id} label="Reset to declared default" onPress={() => setDraft(old => {const next = {...old}; delete next[key]; return next;})}/>}
      </View>;
  };
  return <Modal visible transparent animationType="fade" onRequestClose={() => service.closeReview(review.id)}><View style={[styles.shade, {paddingTop: insets.top}]}><TrustedBand label="Napplet settings" /><FlatList automaticallyAdjustKeyboardInsets testID="configuration-settings" keyboardShouldPersistTaps="handled" data={rows} keyExtractor={field => fieldKey(field.path)} renderItem={renderField} initialNumToRender={8} windowSize={5} removeClippedSubviews={false} contentContainerStyle={[styles.sheet, {paddingBottom: Math.max(insets.bottom, 24)}]} ListHeaderComponent={<View style={styles.group}>
    <Text accessibilityRole="header" style={styles.heading}>Napplet configuration</Text>
    <Text style={styles.title}>{review.origin.appId}</Text><Text selectable style={styles.detail}>{formatNpub(review.origin.publisher)}</Text>
    <Text style={styles.detail}>Selected identity: {formatNpub(review.origin.user)}</Text><Text selectable style={styles.detail}>Version: {review.origin.version}</Text>
    <Text style={styles.detail}>Only Save settings commits changes. Secret values stay masked here and are delivered to this napplet when explicitly supplied.</Text>
  </View>} ListFooterComponent={<View style={styles.group}>
    {status.error !== '' && <Text testID="config-save-error" accessibilityLiveRegion="polite" style={styles.detail}>{status.error}</Text>}
    <Action id="config-save" label={status.busy ? 'Saving settings…' : 'Save settings'} disabled={status.busy} onPress={() => {void save();}}/>
    <Action id="config-cancel" label="Cancel" onPress={() => service.closeReview(review.id)}/>
  </View>}/></View></Modal>;
}
export function Configuration({service, blocked}: {service: ConfigBroker; blocked: boolean}) {
  const {review} = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return !blocked && review ? <Editor key={review.id} service={service} review={review}/> : null;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  group: {gap: 12}, shade: {flex: 1, backgroundColor: colors.shade}, sheet: {backgroundColor: colors.background, padding: 24, gap: 12}, field: {gap: 8, paddingVertical: 8},
  heading: { fontFamily: fonts.display,color: colors.text, fontSize: 28, }, title: { fontFamily: fonts.strong,color: colors.text, fontSize: 18, }, detail: { fontFamily: fonts.body,color: colors.muted, fontSize: 14, lineHeight: 21},
  input: { fontFamily: fonts.body,borderColor: colors.border, borderWidth: 1, borderRadius: 0, minHeight: 44, padding: 12, color: colors.text, fontSize: 16}, button: {backgroundColor: colors.surface, minHeight: 44, padding: 12, borderRadius: 0}, action: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong,color: colors.accent, fontSize: 14},
});
