import { finalizeEvent } from 'nostr-tools/pure';
import { digest, KIND } from '../src/catalog.ts';

const key = (number: number) => new Uint8Array(32).fill(number);
export const clock = 1_790_000_000;
export const artifactHash = '4'.repeat(64);

export function manifest({
  publisher = 1, timestamp = clock - 10, d = 'shared', title = 'Grid Game',
  description = 'Build a board', format = 'modern', extra = [],
}: {
  publisher?: number; timestamp?: number; d?: string; title?: string;
  description?: string; format?: 'modern' | 'legacy'; extra?: string[][];
} = {}) {
  const legacy = format === 'legacy';
  const hashTags = legacy ? [
    ['path', '/index.html', artifactHash],
    ['x', digest(new TextEncoder().encode(`${artifactHash} /index.html\n`)), 'aggregate'],
    ['description', description],
  ] : [['x', artifactHash]];
  return finalizeEvent({ kind: KIND, created_at: timestamp, content: legacy ? '' : description,
    tags: [['d', d], ['title', title], ...hashTags, ...extra] }, key(publisher));
}

export function profile(publisher: number, timestamp: number, content: string) {
  return finalizeEvent({ kind: 0, created_at: timestamp, content, tags: [] }, key(publisher));
}
