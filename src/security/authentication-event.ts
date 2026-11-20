/** Authentication events require a purpose-bound flow and cannot be published as ordinary events. */
export function isAuthenticationEventKind(kind: unknown): boolean {
  return kind === 22242 || kind === 24242 || kind === 27235;
}
