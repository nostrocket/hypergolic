import { resource } from '@napplet/sdk';
import type { Media } from './catalog.ts';
import { MAX_DIMENSION } from './media-header.ts';
import { loadVerifiedImage } from './media-resource.ts';
import { canReadResource } from './host.ts';

async function displayImage(blob: Blob, signal: AbortSignal, apply: (image: HTMLImageElement) => void): Promise<boolean> {
  const image = new Image();
  let displayed = false;
  const url = URL.createObjectURL(blob);
  try {
    image.src = url;
    await image.decode();
    if (!signal.aborted && image.naturalWidth > 0 && image.naturalHeight > 0 &&
      image.naturalWidth <= MAX_DIMENSION && image.naturalHeight <= MAX_DIMENSION) {
      apply(image);
      displayed = true;
    }
  } catch {
    // Invalid media falls through to the generic artwork.
  } finally {
    URL.revokeObjectURL(url);
  }
  return displayed;
}

/** One viewport-scoped, bounded resource queue. No URL from a relay reaches an img element. */
export class ViewMedia {
  private controller = new AbortController();
  private blobs = new Map<string, Promise<Blob | undefined>>();
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  private callbacks = new WeakMap<Element, () => void>();
  private observer = typeof IntersectionObserver === 'undefined' ? undefined :
    new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.observer?.unobserve(entry.target);
        this.callbacks.get(entry.target)?.();
      }
    }, { rootMargin: '80px' });

  show(target: HTMLElement, media: Media, apply: (image: HTMLImageElement) => void): void {
    if (!canReadResource()) return;
    const start = () => {
      if (!target.isConnected) return;
      const key = JSON.stringify([media.hash, media.mime, media.servers]);
      let pending = this.blobs.get(key);
      if (!pending) {
        if (this.blobs.size >= 18) return;
        pending = new Promise(resolve => {
          this.queue.push(async () => {
            const blob = await loadVerifiedImage(media, this.controller.signal, (url, options) => resource.bytes(url, options)).catch(() => undefined);
            resolve(this.controller.signal.aborted ? undefined : blob);
          });
        });
        this.blobs.set(key, pending);
        this.pump();
      }
      void pending.then(blob => {
        if (blob && target.isConnected && !this.controller.signal.aborted) {
          return displayImage(blob, this.controller.signal, image => { if (target.isConnected) apply(image); });
        }
      });
    };
    this.callbacks.set(target, start);
    if (this.observer) this.observer.observe(target);
    else queueMicrotask(start);
  }

  showFirstScreenshot(target: HTMLElement, candidates: readonly Media[], apply: (image: HTMLImageElement, media: Media) => void): void {
    if (!candidates.length || !canReadResource()) return;
    const signal = this.controller.signal;
    this.queue.push(async () => {
      for (const candidate of candidates) {
        if (signal.aborted || !target.isConnected) return;
        const blob = await loadVerifiedImage(candidate, signal, (url, options) => resource.bytes(url, options));
        if (blob && await displayImage(blob, signal, image => {
          if (target.isConnected) apply(image, candidate);
        })) return;
      }
    });
    // Detail constructs its elements before attaching them to the document.
    queueMicrotask(() => this.pump());
  }

  private pump(): void {
    while (this.active < 2 && this.queue.length && !this.controller.signal.aborted) {
      const job = this.queue.shift()!;
      this.active++;
      void job().finally(() => { this.active--; this.pump(); });
    }
  }

  clearTargets(): void {
    this.observer?.disconnect();
    this.callbacks = new WeakMap();
  }

  close(): void {
    this.controller.abort();
    this.observer?.disconnect();
    for (const job of this.queue.splice(0)) void job();
    this.blobs.clear();
  }
}
