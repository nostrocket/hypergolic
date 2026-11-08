import type {NappletMessage} from '@kehto/runtime';
import {createResourceAdapter} from './resource-adapter';
import {createLegacyImageCompletions, type LegacyImageCompletion} from './legacy-image-completions.ts';
import type {createNativeClient} from './native-client';
import type {createLegacyDocumentGuard} from './legacy-lifecycle';

/** Only this trusted controller sees private native descriptors and chunk verbs. */
export function createLegacyImageMount(frame: HTMLIFrameElement, source: Window, session: string,
  native: ReturnType<typeof createNativeClient>, guard: ReturnType<typeof createLegacyDocumentGuard>, live: () => boolean) {
  let closed = false;
  const pending = new Set<string>(), waiting = new Set<() => void>();
  const completions = createLegacyImageCompletions();
  const alive = (): boolean => !closed && live() && frame.contentWindow === source;
  const adapter = createResourceAdapter({request(message) {
    return new Promise<NappletMessage>((resolve, reject) => {
      const cancel = (): void => reject(new Error('Legacy image document closed'));
      waiting.add(cancel);
      guard.run(() => {
        waiting.delete(cancel);
        if (!alive()) {cancel(); return;}
        const type = message.type.replace(/^resource\./, 'legacy.image.');
        void native.request({...message, type} as NappletMessage).then(reply =>
          resolve({...reply, type: reply.type.replace(/^legacy\.image\./, 'resource.')} as NappletMessage), reject);
      }, 128);
    });
  }}, () => alive);
  const cancel = (id: string): void => {
    pending.delete(id); completions.drop(id);
    void adapter({message: {type: 'resource.cancel', id}, send() {}});
  };
  const deliver = (id: string): void => {
    const result = completions.take(id);
    if (!result || !alive() || !pending.delete(id)) return;
    source.postMessage({type: 'legacy.image.result', session, id, ...result}, '*');
  };
  const complete = (id: string, reply: unknown): void => {
    if (!alive() || !pending.has(id)) return;
    const result = reply as Record<string, unknown>;
    const completion: LegacyImageCompletion = result.blob instanceof Blob ? {blob: result.blob, mime: result.blob.type}
      : {error: typeof result.error === 'string' ? result.error : 'decode-failed'};
    if (!completions.put(id, completion)) completions.put(id, {error: 'quota-exceeded'});
    // Only the ID enters the 256 KiB document queue. Blob retention has its own 10 MiB aggregate budget.
    guard.run(() => deliver(id), 128);
  };
  return Object.freeze({
    receive(event: MessageEvent): boolean {
      const value = event.data;
      if (value?.type !== 'legacy.image') return false;
      if (!event.isTrusted || event.source !== source || !alive() || !guard.isActive() || value.session !== session ||
        typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value.id)) return true;
      if (value.operation === 'cancel' && Object.keys(value).length === 4) {cancel(value.id); return true;}
      if (value.operation !== 'bytes' || Object.keys(value).length !== 5 || typeof value.url !== 'string' ||
        new TextEncoder().encode(value.url).length > 8192 || pending.has(value.id)) return true;
      const id = value.id;
      if (pending.size >= 4) {source.postMessage({type: 'legacy.image.result', session, id, error: 'quota-exceeded'}, '*'); return true;}
      pending.add(id);
      void adapter({message: {type: 'resource.bytes', id, url: value.url}, send: reply => complete(id, reply)});
      return true;
    },
    close() {
      if (closed) return;
      for (const id of pending) {
        // Teardown cancellation must not wait for a document challenge that can no longer finish.
        void native.request({type: 'legacy.image.cancel', id} as NappletMessage).catch(() => {});
      }
      closed = true; pending.clear(); completions.close();
      for (const cancel of waiting) cancel(); waiting.clear();
    },
  });
}
