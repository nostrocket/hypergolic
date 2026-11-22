import { digest, type Media } from './catalog.ts';
import { imageMime } from './media-header.ts';

const MAX_BLOB = 768 * 1024;
const MAX_MIRRORS = 4;
type ReadResource = (url: string, options: { signal: AbortSignal }) => Promise<Blob>;

/** Signed mirrors use the existing public HTTPS Resource policy, never browser networking. */
export async function loadVerifiedImage(media: Media, signal: AbortSignal, read: ReadResource): Promise<Blob | undefined> {
  const urls = [...new Set(media.servers ?? [])].slice(0, MAX_MIRRORS).map(origin => `${origin}/${media.hash}`);
  urls.push(`blossom:sha256:${media.hash}`);
  for (const url of urls) {
    if (signal.aborted) return;
    try {
      const blob = await read(url, { signal });
      if (signal.aborted) return;
      if (blob.size === 0 || blob.size > MAX_BLOB) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const mime = imageMime(bytes);
      if (signal.aborted) return;
      if (mime && (!media.mime || mime === media.mime) && digest(bytes) === media.hash) {
        return new Blob([bytes], { type: mime });
      }
    } catch {
      // An unavailable or invalid mirror cannot replace the publisher's verified artwork.
    }
  }
}
