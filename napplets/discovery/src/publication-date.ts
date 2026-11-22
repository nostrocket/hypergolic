const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Preserve the detail view even when a signed timestamp is outside Date's range. */
export function publicationTimestamp(seconds: number): { iso: string; label: string } | undefined {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return;
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return;
  return { iso: date.toISOString(), label: `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}` };
}
