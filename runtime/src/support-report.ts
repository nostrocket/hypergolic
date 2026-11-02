import { NAP_CATALOGUE } from '../../src/runtime/nap-catalogue.ts';
import { supportForDomain, SUPPORT_PROFILE } from '../../src/runtime/support-report.ts';

/** Public advisory metadata. This does not grant permissions or extend the NAP wire. */
export function injectSupportReport(html: string): string {
  const report = {schemaVersion: 2, scope: 'published-napplets', shell: 'Hypergolic', profile: SUPPORT_PROFILE,
    domains: NAP_CATALOGUE.map(row => ({domain: row.domain, ...supportForDomain(row.domain)}))};
  const encoded = JSON.stringify(report).replace(/</g, '\\u003c');
  const script = `<script>(()=>{const r=${encoded};r.domains.forEach(Object.freeze);Object.freeze(r.domains);Object.freeze(r);Object.defineProperty(window,'hypergolicSupportReport',{value:r,writable:false,configurable:false});})();</script>`;
  // Insert immediately after our CSP and before any publisher script.
  return html.replace(/(<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>)/i, match => match + script);
}
