import './style.css';
import { NAP_CATALOGUE, NAP_CATALOGUE_REVIEWED, NAP_REGISTRY_REVISION } from '../../../src/runtime/nap-catalogue.ts';
import type { SupportAvailability } from '../../../src/runtime/support-report.ts';

type Report = {schemaVersion: 2; scope: 'published-napplets'; shell: string; profile: string; domains: readonly {domain: string; status: SupportAvailability; detail: string}[]};
type Shell = {ready(): Promise<unknown>; supports(domain: string): boolean};
const surface = window as Window & {hypergolicSupportReport?: Report; napplet?: {shell?: Shell; link?: {open(url: string): Promise<unknown>}}};
const labels: Record<SupportAvailability, string> = {available: 'Available', unavailable: 'Unavailable', unknown: 'Unknown'};
const symbols: Record<SupportAvailability, string> = {available: '✓', unavailable: '✕', unknown: '?'};
function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing support control');
  return node as T;
}
const host = element('host'), list = element('naps'), count = element('count');
const search = element<HTMLInputElement>('search');
const empty = element('empty');
let filter = 'all';
let report: Report | undefined;
let discoveryReady = false;
const icons: Record<string, string> = {
  fs: 'M3 6h6l2 2h10v12H3Z',
  media: 'M4 4h16v16H4Z M10 8l6 4-6 4Z',
  storage: 'M3 5h18v4H3Z M3 11h18v3H3Z M3 16h18v3H3Z',
  identity: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
  resource: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M3 12h18 M12 3c-6 5-6 13 0 18 M12 3c6 5 6 13 0 18',
  link: 'M10 7l2-2a5 5 0 0 1 7 7l-2 2 M14 17l-2 2a5 5 0 0 1-7-7l2-2 M8 16l8-8',
  relay: 'M6 8a6 6 0 0 0 0 8 M3 5a10 10 0 0 0 0 14 M18 8a6 6 0 0 1 0 8 M21 5a10 10 0 0 1 0 14 M12 10v4',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 16v5h16v-5',
  theme: 'M12 3a9 9 0 1 0 0 18V3 M12 3v18',
  config: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
};
function icon(domain: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', icons[domain] ?? 'M12 3l8 5v8l-8 5-8-5V8Z M8 12h8');
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  svg.append(path); return svg;
}
function text(tag: string, value: string, className = ''): HTMLElement {
  const node = document.createElement(tag); node.textContent = value; node.className = className; return node;
}
function support(domain: string) {
  const row = report?.domains.find(value => value.domain === domain);
  if (row && ['available', 'unavailable', 'unknown'].includes(row.status) && typeof row.detail === 'string') return {...row, label: labels[row.status],
    scope: 'Published napplets', source: 'Shell-reported availability and reviewed limits'};
  if (discoveryReady) {
    try {
      const available = domain === 'shell' ? true : surface.napplet?.shell?.supports(domain);
      if (typeof available === 'boolean') return {domain, status: available ? 'available' as const : 'unavailable' as const,
        label: available ? 'Available' : 'Not offered', scope: 'This napplet', source: 'Shell handshake and scoped discovery',
        detail: available ? 'Available to this napplet. Discovery does not establish complete conformance.'
          : 'Not offered to this napplet. The shell may lack this NAP or may not have granted it to this napplet.'};
    } catch { /* A failed query is unknown, not evidence of missing support. */ }
  }
  return {domain, status: 'unknown' as const, label: 'Unknown', scope: 'This napplet', source: 'No completed discovery result',
    detail: 'Availability is unknown until shell discovery completes successfully.'};
}
function render(): void {
  const query = search.value.trim().toLowerCase();
  const rows = NAP_CATALOGUE.filter(row => {
    const current = support(row.domain);
    return `${row.domain} ${row.name} ${row.description}`.toLowerCase().includes(query) &&
      (filter === 'all' || current.status === filter);
  });
  list.replaceChildren();
  for (const row of rows) {
    const current = support(row.domain);
    const item = document.createElement('li'); item.dataset.domain = row.domain;
    const details = document.createElement('details'), summary = document.createElement('summary');
    const name = text('span', '', 'name'); name.append(text('span', row.domain, 'domain'), text('span', `${row.name} · ${row.status}`, 'proposal'));
    const badge = text('span', '', `support ${current.status}`);
    const mark = text('span', symbols[current.status], 'symbol'); mark.setAttribute('aria-hidden', 'true');
    badge.append(mark, text('span', current.label));
    summary.append(icon(row.domain), name, badge, text('span', '›', 'chevron'));
    const detail = text('div', '', 'detail');
    detail.append(text('p', row.description), text('p', current.detail),
      text('p', `${current.scope}: ${current.label}${current.status === 'available' ? ', subject to permission' : ''}.`, 'availability'),
      text('p', `Source: ${current.source}. Availability is not a full conformance result.`),
      text('p', `Upstream status: ${row.status}. Catalogue reviewed ${NAP_CATALOGUE_REVIEWED}.`));
    const source = document.createElement('a'); source.href = row.source; source.textContent = 'View proposal';
    source.addEventListener('click', event => {
      event.preventDefault();
      if (surface.napplet?.shell?.supports('link')) void surface.napplet.link?.open(row.source).catch(() => {host.textContent = 'Link was declined or unavailable. The source address is shown below.';});
      else host.textContent = 'Link access is unavailable. Select the source address below.';
    });
    detail.append(source, text('p', row.source, 'source'), text('p', `Revision ${row.revision}`, 'source'));
    details.append(summary, detail); item.append(details); list.append(item);
  }
  count.textContent = `${rows.length} of ${NAP_CATALOGUE.length} reviewed NAPs`;
  empty.hidden = rows.length > 0;
}
function chooseFilter(button: HTMLButtonElement): void {
  filter = button.dataset.filter ?? 'all';
  for (const other of document.querySelectorAll<HTMLButtonElement>('[data-filter]')) other.setAttribute('aria-pressed', String(other === button));
  render();
}
search.addEventListener('input', render);
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-filter]')) button.onclick = () => chooseFilter(button);
element('reviewed').textContent = `Registry ${NAP_REGISTRY_REVISION.slice(0, 8)} · reviewed ${NAP_CATALOGUE_REVIEWED}`;
async function start(): Promise<void> {
  const shell = surface.napplet?.shell;
  if (!shell) { host.textContent = 'No shell environment. Availability is unknown.'; return; }
  const deadline = window.setTimeout(() => {
    host.textContent = 'Shell discovery has not completed. Availability is unknown.';
    render();
  }, 4000);
  try {
    await shell.ready();
    discoveryReady = true;
    const supplied = surface.hypergolicSupportReport;
    if (supplied?.schemaVersion === 2 && supplied.scope === 'published-napplets' && Array.isArray(supplied.domains)) report = supplied;
    host.textContent = report ? `${report.shell} · shell-reported availability for published napplets`
      : 'Availability for this napplet · standard shell discovery';
    element('unavailable-filter').textContent = report ? 'Unavailable' : 'Not offered';
  } catch { host.textContent = 'Shell discovery failed. Availability is unknown.'; }
  finally { window.clearTimeout(deadline); }
  render();
}
render(); void start();
