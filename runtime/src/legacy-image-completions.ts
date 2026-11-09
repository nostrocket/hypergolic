export type LegacyImageCompletion = Readonly<{blob: Blob; mime: string}> | Readonly<{error: string}>;
/** Separate from the document guard's small-message queue: queued actions retain IDs only. */
export function createLegacyImageCompletions() {
  const values = new Map<string, LegacyImageCompletion>();
  const limit = 10 * 1024 * 1024;
  let bytes = 0, closed = false;
  const size = (value: LegacyImageCompletion): number => 'blob' in value ? value.blob.size : 0;
  const take = (id: string): LegacyImageCompletion | undefined => {
    const value = values.get(id);
    if (value) {values.delete(id); bytes -= size(value);}
    return value;
  };
  return Object.freeze({
    put(id: string, value: LegacyImageCompletion): boolean {
      if (closed) return false;
      take(id);
      if (size(value) > limit - bytes) return false;
      values.set(id, value); bytes += size(value); return true;
    },
    take,
    drop(id: string): void {take(id);},
    close(): void {closed = true; values.clear(); bytes = 0;},
  });
}
