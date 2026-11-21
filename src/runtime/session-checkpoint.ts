import type {CloseCheckEvent} from '../shell/close-check.ts';
type Command = Readonly<{generation: string; id: string}>;
export type SessionCheckpoint = ReturnType<typeof createSessionCheckpoint>;

/** One native generation, one background save. A remount may consume only its committed receipt. */
export function createSessionCheckpoint(resume: string | null, restored: () => void) {
  let generation: string | null = null, saved: Command | null = null, pending: Command | null = null;
  const listeners = new Set<() => void>();
  let command = '';
  function publish() {
    const next = pending ? JSON.stringify(pending) : '';
    if (command === next) return;
    command = next;
    for (const listener of listeners) listener();
  }
  function cancel() {saved = null; pending = null; publish();}
  return Object.freeze({
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    getSnapshot: () => command,
    cancel,
    ready(value: string) {generation = value; cancel();},
    saved: () => saved,
    restoring: () => resume !== null,
    request(background: boolean, newId: () => string): Command | null {
      saved = null; pending = null;
      if (!generation) return null;
      if (resume) pending = {generation, id: resume.replace('resume-', 'restore-')};
      else if (background) pending = {generation, id: 'resume-' + newId()};
      publish();
      return pending;
    },
    receive(event: CloseCheckEvent): boolean {
      if (!pending || event.generation !== generation || event.id !== pending.id) return false;
      if (event.state === 'clean') {
        if (resume) {resume = null; restored();}
        else saved = pending;
      }
      pending = null; publish();
      return true;
    },
  });
}
