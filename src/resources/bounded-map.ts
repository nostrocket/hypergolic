/** Ordered results with two workers; no caller can enqueue an unbounded burst of native work. */
export async function mapResourceItems<T, R>(items: readonly T[], operation: (item: T) => Promise<R>): Promise<R[]> {
  let cursor = 0;
  const results: R[] = [];
  const worker = async (): Promise<void> => {
    const index = cursor++;
    if (index >= items.length) return;
    results[index] = await operation(items[index]!);
    return worker();
  };
  await Promise.all([worker(), worker()]);
  return results;
}
