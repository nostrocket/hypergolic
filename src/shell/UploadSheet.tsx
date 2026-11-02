import { TrustedBand } from './TrustedBand';
import { useMemo, useState } from 'react';
import { Image } from 'expo-image';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UploadItem } from '../uploads/upload-service.ts';
import { formatNpub } from '../security/public-identity.ts';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
interface Props {item: UploadItem | null; title: string; onApprove(id: string): void; onReject(id: string): void}
function preview(item: UploadItem): string | null {
  const bytes = item.copyPreview(); if (!bytes || item.review.mimeType !== 'image/png') return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks: string[] = [];
  try {
    for (let start = 0; start < bytes.length; start += 3 * 4096) {
      let output = '';
      for (let offset = start; offset < Math.min(start + 3 * 4096, bytes.length); offset += 3) {
        const a = bytes[offset]!, b = bytes[offset + 1] ?? 0, c = bytes[offset + 2] ?? 0;
        output += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | (b >> 4)]! +
          (offset + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)]! : '=') +
          (offset + 2 < bytes.length ? alphabet[c & 63]! : '=');
      }
      chunks.push(output);
    }
    return 'data:image/png;base64,' + chunks.join('');
  } finally {bytes.fill(0);}
}
function inspection(item: UploadItem): string | null {
  const bytes = item.copyPreview(); if (!bytes) return null;
  try {
    return Array.from(bytes.subarray(0, 256), byte => byte.toString(16).padStart(2, '0'))
      .reduce<string[]>((lines, pair, index) => {const row = Math.floor(index / 16); lines[row] = (lines[row] || '') + (index % 16 ? ' ' : '') + pair; return lines;}, []).join('\n');
  } finally {bytes.fill(0);}
}
function Review({item, title, onApprove, onReject}: Omit<Props, 'item'> & {item: UploadItem}) {
  const { styles } = useShellStyles(createStyles);
  const insets = useSafeAreaInsets(), [decoded, setDecoded] = useState(false);
  const uri = useMemo(() => item.previewReady ? preview(item) : null, [item]);
  const header = useMemo(() => item.previewReady && item.review.metadataPolicy === 'attachment-unchanged' ? inspection(item) : null, [item]);
  const canApprove = item.previewReady && (item.review.metadataPolicy === 'attachment-unchanged' ? header !== null : decoded);
  return <Modal transparent animationType="none" visible onRequestClose={() => onReject(item.id)}>
    <View style={styles.backdrop}><View testID="upload-sheet" accessibilityViewIsModal style={[styles.sheet, {paddingBottom: Math.max(16, insets.bottom)}]}>
      <TrustedBand />
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Approve file upload</Text>
        {uri ? <Image testID="upload-preview" accessibilityLabel="Exact photo selected for upload" source={{uri}} contentFit="contain" cachePolicy="none" recyclingKey={item.id} style={styles.preview}
          onLoad={() => setDecoded(true)} onError={() => setDecoded(false)} /> : header !== null ? <View>
          <Text accessibilityRole="header" style={styles.label}>File inspection</Text>
          <Text style={styles.detail}>First {Math.min(item.review.size, 256)} bytes in hexadecimal. The reviewed type, size and SHA-256 identify the complete unchanged attachment.</Text>
          <Text testID="upload-attachment-inspection" selectable style={styles.mono}>{header}</Text>
        </View> : <Text style={styles.detail}>Preparing reviewed file…</Text>}
        <Text style={styles.label}>Requesting napplet</Text><Text style={styles.detail}>{title}</Text>
        <Text style={styles.label}>Publisher</Text><Text selectable style={styles.mono}>{item.origin.publisher === 'f'.repeat(64) && item.origin.appId === 'upload-lab' ? 'Unsigned bundled fixture' : formatNpub(item.origin.publisher)}</Text>
        <Text style={styles.label}>Selected identity</Text><Text testID="upload-review-identity" selectable style={styles.mono}>{formatNpub(item.review.identity)}</Text>
        <Text style={styles.label}>Upload to</Text><Text testID="upload-review-destination" selectable style={styles.mono}>{item.review.destination}</Text>
        <Text style={styles.detail}>{item.filename || 'Selected file'}{'\n'}{item.review.mimeType} · {item.review.size.toLocaleString()} bytes</Text>
        {item.caption !== '' && <Text selectable style={styles.detail}>Caption requested by napplet: {item.caption}</Text>}
        <Text style={styles.detail}>{item.review.metadataPolicy === 'photo-stripped' ? 'Prepared PNG photo with no embedded personal metadata. Supported photos are converted to PNG when needed, without resizing. Displayed orientation and color are preserved.' : 'This attachment is unchanged. Embedded metadata may still be included.'}</Text>
        <Text style={styles.detail}>Approval sends this file using your selected identity. Cancelling after transfer starts may leave a copy on the server.</Text>
        <Text style={styles.label}>Reviewed SHA-256</Text><Text testID="upload-review-hash" selectable style={styles.mono}>{item.review.sha256}</Text>
      </ScrollView>
      <View style={styles.actions}>
        <Pressable testID="upload-approve" accessibilityRole="button" accessibilityState={{disabled: !canApprove}} disabled={!canApprove} onPress={() => onApprove(item.id)} style={[styles.approve, (!canApprove) && styles.disabled]}><Text style={styles.approveText}>Approve once</Text></Pressable>
        <Pressable testID="upload-reject" accessibilityRole="button" onPress={() => onReject(item.id)} style={styles.reject}><Text style={styles.detail}>Reject upload</Text></Pressable>
      </View>
    </View></View>
  </Modal>;
}
export function UploadSheet(props: Props) {return props.item ? <Review key={props.item.id} {...props} item={props.item} /> : null;}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({backdrop: {flex: 1, backgroundColor: colors.shade, justifyContent: 'flex-end'},
  sheet: {maxHeight: '92%', backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border, borderTopLeftRadius: 0, borderTopRightRadius: 0},
  content: {padding: 24, gap: 10}, title: { fontFamily: fonts.display,color: colors.text, fontSize: 28, }, preview: {width: '100%', height: 220, backgroundColor: colors.background},
  label: { textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: fonts.mono,color: colors.muted, fontSize: 12, marginTop: 8}, detail: { fontFamily: fonts.body,color: colors.text, fontSize: 15, lineHeight: 22}, mono: { fontFamily: fonts.mono,color: colors.text, fontSize: 12, lineHeight: 19},
  actions: {padding: 24, gap: 10, borderTopWidth: 1, borderColor: colors.border}, approve: {minHeight: 52, borderRadius: 0, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center'}, approveText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong,color: colors.onPrimary, fontSize: 14, },
  reject: {minHeight: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 0}, disabled: {opacity: 0.5}});
