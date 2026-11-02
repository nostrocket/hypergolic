import { identity, relay, type EventTemplate } from '@napplet/sdk';
import { element } from './view';
import { connectTheme } from './theme';
import './style.css';

const LIMIT = 4;
const DELAY_MS = 5_000;
const controls = element<HTMLFieldSetElement>('controls');
const contentInput = element<HTMLTextAreaElement>('content');
const noteKind = element<HTMLInputElement>('kind-note');
const profileKind = element<HTMLInputElement>('kind-profile');
const relayListKind = element<HTMLInputElement>('kind-relay-list');
const relayTags = element<HTMLTextAreaElement>('relay-list-tags');
const results = element<HTMLOListElement>('results');
const send = element<HTMLButtonElement>('send');
const sendThree = element<HTMLButtonElement>('send-three');
const sendDelayed = element<HTMLButtonElement>('send-delayed');
const clear = element<HTMLButtonElement>('clear');

type State = 'scheduled' | 'sending' | 'published' | 'failed' | 'cancelled' | 'ignored';
type Request = {
  sequence: number;
  epoch: number;
  event: EventTemplate;
  state: State;
  row: HTMLLIElement;
};

let publicKey = '';
let identityEpoch = 0;
let disposed = false;
let nextSequence = 1;
let createdCount = 0;
const requests = new Map<number, Request>();
const timers = new Map<number, number>();

// NAP-RELAY's selected contract accepts this unsigned shape. Keep the package
// type adaptation here so fixture requests never acquire placeholder signed fields.
const publishUnsigned = (event: EventTemplate): Promise<unknown> => relay.publish(event);

function active(request: Request): boolean {
  return request.state === 'scheduled' || request.state === 'sending';
}

function activeCount(): number {
  return [...requests.values()].filter(active).length;
}

function relayListPending(): boolean {
  return [...requests.values()].some((request) => active(request) && request.event.kind === 10002);
}

function updateControls(): void {
  const remaining = LIMIT - activeCount();
  controls.disabled = disposed || !publicKey;
  const listPending = relayListKind.checked && relayListPending();
  send.disabled = remaining < 1 || listPending;
  sendDelayed.disabled = remaining < 1 || listPending;
  sendThree.disabled = remaining < 3 || relayListKind.checked;
  clear.disabled = ![...requests.values()].some((request) => !active(request));
  element('pending').textContent = String(activeCount());
  element('requests').textContent = String(createdCount);
}

function statusText(state: State): string {
  if (state === 'scheduled') return 'Waiting 5 seconds';
  if (state === 'sending') return 'Waiting for shell approval';
  if (state === 'published') return 'Published';
  if (state === 'failed') return 'Failed';
  if (state === 'cancelled') return 'Cancelled before submission';
  return 'Ignored after identity changed';
}

function paint(request: Request, detail = ''): void {
  request.row.dataset.state = request.state;
  request.row.querySelector<HTMLElement>('.request-state')!.textContent = statusText(request.state);
  request.row.querySelector<HTMLElement>('.event-id')!.textContent = detail;
}

function makeRow(sequence: number, event: EventTemplate): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'request';
  row.dataset.sequence = String(sequence);
  row.dataset.kind = String(event.kind);
  const head = document.createElement('div');
  head.className = 'request-head';
  const correlation = document.createElement('span');
  correlation.textContent = `Local request ${sequence}`;
  const state = document.createElement('span');
  state.className = 'request-state';
  head.append(correlation, state);
  const kind = document.createElement('p');
  kind.className = 'request-kind meta';
  kind.textContent = event.kind === 10002 ? 'Relay list (kind 10002)'
    : event.kind === 0 ? 'Profile metadata (kind 0)' : 'Note (kind 1)';
  const body = document.createElement('code');
  body.className = 'request-content';
  body.textContent = event.kind === 10002 ? JSON.stringify(event.tags, null, 2) : event.content;
  const eventId = document.createElement('output');
  eventId.className = 'event-id';
  row.append(head, kind, body, eventId);
  results.prepend(row);
  return row;
}

// Format guidance only. Native destination, identity and approval policy remain authoritative.
type RelayTagsCapture = { ok: true; tags: string[][] } | { ok: false; error: string };
function captureRelayTags(): RelayTagsCapture {
  try {
    const input: unknown = JSON.parse(relayTags.value);
    if (!Array.isArray(input) || input.length > 16) throw new Error();
    const tags: string[][] = [];
    for (const tag of input) {
      if (!Array.isArray(tag) || (tag.length !== 2 && tag.length !== 3) ||
          tag[0] !== 'r' || typeof tag[1] !== 'string' ||
          tag[1].length > 2048 || /[\u0000-\u0020\u007f]/.test(tag[1]) ||
          (tag.length === 3 && tag[2] !== 'read' && tag[2] !== 'write')) throw new Error();
      const url = new URL(tag[1]);
      if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw new Error();
      tags.push([...tag]);
    }
    return { ok: true, tags };
  } catch {
    return { ok: false, error: 'Enter a JSON array of up to 16 r tags. Each needs a wss relay URL and, optionally, read or write.' };
  }
}

function createRequest(state: 'scheduled' | 'sending'): Request | null {
  if (disposed || !publicKey || activeCount() >= LIMIT) return null;
  const relayList = relayListKind.checked;
  if (relayList && relayListPending()) return null;
  const capture: RelayTagsCapture = relayList ? captureRelayTags() : { ok: true, tags: [] };
  if (!capture.ok) {
    element('relay-list-error').textContent = capture.error;
    relayTags.setAttribute('aria-invalid', 'true');
    relayTags.focus();
    return null;
  }
  element('relay-list-error').textContent = '';
  relayTags.removeAttribute('aria-invalid');
  const sequence = nextSequence++;
  const tags: string[][] = [
    ...capture.tags,
    ['t', 'hypergolic-approval-lab'],
    ['test-sequence', String(sequence)],
  ];
  tags.forEach(Object.freeze);
  Object.freeze(tags);
  const kind = relayList ? 10002 : profileKind.checked ? 0 : 1;
  const event = Object.freeze({
    kind,
    content: kind === 10002 ? '' : kind === 0 ? JSON.stringify({ about: contentInput.value }) : contentInput.value,
    tags,
    created_at: Math.floor(Date.now() / 1_000),
  }) as EventTemplate;
  const request: Request = {
    sequence,
    epoch: identityEpoch,
    event,
    state,
    row: makeRow(sequence, event),
  };
  requests.set(sequence, request);
  createdCount++;
  paint(request);
  element('status').textContent = state === 'scheduled'
    ? `Request ${sequence} captured. Submission waits 5 seconds.`
    : `Request ${sequence} captured and sent to the shell.`;
  updateControls();
  return request;
}

function eventId(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('id' in value)) return '';
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && /^[0-9a-f]{64}$/i.test(id) ? id : '';
}

function issue(request: Request): void {
  timers.delete(request.sequence);
  if (disposed || request.epoch !== identityEpoch || !active(request)) return;
  request.state = 'sending';
  paint(request);
  updateControls();
  void publishUnsigned(request.event).then((result) => {
    if (disposed || request.epoch !== identityEpoch || request.state !== 'sending') return;
    const id = eventId(result);
    if (!id) {
      request.state = 'failed';
      paint(request, 'Shell returned no verifiable event ID');
      element('status').textContent = `Request ${request.sequence} failed. No automatic retry.`;
      return;
    }
    request.state = 'published';
    paint(request, `Event ID ${id}`);
    element('status').textContent = `Request ${request.sequence} published.`;
  }).catch((error) => {
    if (disposed || request.epoch !== identityEpoch || request.state !== 'sending') return;
    request.state = 'failed';
    const message = error instanceof Error ? error.message.slice(0, 240) : 'publication unavailable';
    paint(request, message);
    element('status').textContent = `Request ${request.sequence} failed. No automatic retry.`;
  }).finally(() => {
    updateControls();
  });
}

function submitOne(): void {
  const request = createRequest('sending');
  if (request) issue(request);
}

function submitThree(): void {
  if (relayListKind.checked || LIMIT - activeCount() < 3) return;
  for (let index = 0; index < 3; index++) {
    const request = createRequest('sending');
    if (request) issue(request);
  }
}

function submitDelayed(): void {
  const request = createRequest('scheduled');
  if (!request) return;
  timers.set(request.sequence, window.setTimeout(() => { issue(request); }, DELAY_MS));
}

function invalidateActive(reason: 'identity' | 'pagehide'): void {
  identityEpoch++;
  for (const request of requests.values()) {
    if (!active(request)) continue;
    const timer = timers.get(request.sequence);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.delete(request.sequence);
      request.state = 'cancelled';
    } else {
      request.state = 'ignored';
    }
    paint(request, reason === 'identity' ? 'Identity changed before completion' : 'Page closed before completion');
  }
  updateControls();
}

function acceptIdentity(value: string): void {
  invalidateActive('identity');
  publicKey = value.length === 64 && /^[0-9a-f]{64}$/.test(value) ? value : '';
  element('identity').textContent = publicKey;
  element('identity').setAttribute('aria-label', publicKey ? `Selected public identity: ${publicKey}` : 'No identity selected');
  element('identity-status').textContent = publicKey ? 'Identity connected' : 'No identity selected';
  updateControls();
}

function connectIdentity(): void {
  let changed = false;
  try {
    const subscription = identity.onChanged((value) => {
      if (disposed) return;
      changed = true;
      acceptIdentity(value);
    });
    window.addEventListener('pagehide', () => {
      if (disposed) return;
      disposed = true;
      invalidateActive('pagehide');
      subscription.close();
      updateControls();
    });
    void identity.getPublicKey().then((initial) => {
      if (!changed && !disposed) acceptIdentity(initial);
    }).catch(() => {
      if (!changed && !disposed) {
        controls.disabled = true;
        element('identity-status').textContent = 'Open in a shell with identity and relay access';
      }
    });
  } catch {
    if (!changed && !disposed) {
      controls.disabled = true;
      element('identity-status').textContent = 'Open in a shell with identity and relay access';
    }
  }
}

function updateEventType(): void {
  const profile = profileKind.checked;
  const relayList = relayListKind.checked;
  element('content-editor').hidden = relayList;
  element('relay-list-editor').hidden = !relayList;
  element('relay-list-warning').hidden = !relayList;
  element('content-label').textContent = profile ? 'Profile bio' : 'Note content';
  element('profile-warning').hidden = !profile;
  send.textContent = relayList ? 'Send relay list' : profile ? 'Send profile metadata' : 'Send note';
  sendThree.textContent = relayList ? 'Send one relay list at a time' : profile ? 'Send 3 profile updates' : 'Send 3 notes';
  updateControls();
}

noteKind.addEventListener('change', updateEventType);
profileKind.addEventListener('change', updateEventType);
relayListKind.addEventListener('change', updateEventType);
relayTags.addEventListener('input', () => {
  element('relay-list-error').textContent = '';
  relayTags.removeAttribute('aria-invalid');
});
send.addEventListener('click', submitOne);
sendThree.addEventListener('click', submitThree);
sendDelayed.addEventListener('click', submitDelayed);
clear.addEventListener('click', () => {
  for (const [sequence, request] of requests) {
    if (!active(request)) {
      request.row.remove();
      requests.delete(sequence);
    }
  }
  element('status').textContent = activeCount() ? 'Completed results cleared.' : 'Results cleared.';
  updateControls();
});

element('lab').dataset.ready = 'true';
updateControls();
void connectIdentity();
void connectTheme();
