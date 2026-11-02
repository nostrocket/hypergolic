/** Turn native host state into a short status suitable for the visible shell. */
export function runtimeStatus(event: { type: 'ready' } | { type: 'error'; code: string }): string {
  if (event.type === 'ready') return 'Runtime connected';
  if (event.code === 'webview-update-required') {
    return 'Android System WebView needs an update before napplets can open.';
  }
  return `Runtime unavailable: ${event.code}`;
}
