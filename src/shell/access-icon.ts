import { base64 } from '@scure/base';

// Outline artwork in a 24 × 24 view box, keyed by the declared NAP domain.
const paths = new Map<string, string>([
  ['cvm', 'M12 2.5 21 7.5v9L12 22l-9-5.5v-9z M3 7.5l9 5 9-5 M12 12.5V22'],
  ['identity', 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M3 21v-1c0-4 4-6 9-6s9 2 9 6v1'],
  ['relay', 'M4.6 15.5a9 9 0 1 1 14.8 0 M7.8 13a5 5 0 1 1 8.4 0 M13.5 10a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z M7.5 22 12 12l4.5 10 M9 19h6'],
  ['outbox', 'M3 13l2-4h3 M16 9h3l2 4v7H3v-7h5l1.5 3h5l1.5-3h5 M12 12V2m-4 4 4-4 4 4'],
  ['fs', 'M3 6h7l2 3h9v11H3z M3 6V4h7l2 2h7v3'],
  ['storage', 'M20 5.5c0 2-3.6 3.5-8 3.5s-8-1.5-8-3.5S7.6 2 12 2s8 1.5 8 3.5z M4 5.5v13c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5v-13 M4 12c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5'],
  ['theme', 'M20.5 14.3A9 9 0 0 1 9.7 3.5a9 9 0 1 0 10.8 10.8z'],
  ['shell', 'M3 4h18v16H3z M3 8h18 M7 12l2 2-2 2 M12 16h4'],
  ['resource', 'M12 3v12m-5-5 5 5 5-5 M4 15v5h16v-5'],
  ['upload', 'M5 2.5h9l5 5V21H5z M14 3v5h5 M12 18v-7m-3 3 3-3 3 3'],
  ['link', 'M10 14l4-4 M8 15l-1 1a3 3 0 0 1-4-4l4-4a4 4 0 0 1 5.5 0 M16 9l1-1a3 3 0 0 1 4 4l-4 4a4 4 0 0 1-5.5 0'],
  ['intent', 'M3 5h7v7H3z M14 14h7v7h-7z M14 6h3a2 2 0 0 1 2 2v3m-3-3 3 3 3-3'],
  ['inc', 'M2.5 3.5h14v10H8L4 17v-3.5H2.5z M10 17v1.5h6l4 3v-3h1.5V9H20'],
  ['notify', 'M4 17c2-2 2.5-4 2.5-7a5.5 5.5 0 0 1 11 0c0 3 .5 5 2.5 7z M10 20a2.2 2.2 0 0 0 4 0 M12 2v2'],
  ['config', 'M3 6h4m4 0h10 M3 12h12m4 0h2 M3 18h2m4 0h12 M7 4v4h4V4z M15 10v4h4v-4z M5 16v4h4v-4z'],
  ['keys', 'M2 5h20v14H2z M6 9h1m3 0h1m3 0h1m3 0h.2 M6 12h1m3 0h1m3 0h1m3 0h.2 M8 15h8'],
  ['media', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M10 8l6 4-6 4z'],
  ['dm', 'M3 5h18v14H3z M3 6l9 7 9-7'],
  ['lists', 'M8 6h13 M8 12h13 M8 18h13 M3 6h.1 M3 12h.1 M3 18h.1'],
  ['common', 'M3 8h18v12H3z M8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3 M3 12l9 2 9-2 M12 12v3'],
]);

export function accessIconPath(domain: string): string {
  return paths.get(domain) ?? 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M9 9a3 3 0 1 1 4.5 2.6C12 12.4 12 13 12 14 M12 17h.01';
}

export function accessIconUri(domain: string, stroke: string): string {
  const path = accessIconPath(domain);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
    <path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return 'data:image/svg+xml;base64,' + base64.encode(new TextEncoder().encode(svg));
}
