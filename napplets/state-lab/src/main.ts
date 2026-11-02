import { identity, storage } from '@napplet/sdk';
import { element } from './view';
import { connectTheme } from './theme';
import './style.css';

const controls = element<HTMLFieldSetElement>('controls');
const publicControls = element<HTMLFieldSetElement>('public-controls');
const profileControls = element<HTMLFieldSetElement>('profile-controls');
const keyInput = element<HTMLInputElement>('key');
const valueInput = element<HTMLTextAreaElement>('value');
const scopeInput = element<HTMLSelectElement>('scope');
let publicKey = '';
let identityEpoch = 0;
let pending = false;
let disposed = false;
let requests = 0;

function acceptIdentity(value: string): void {
  identityEpoch++;
  publicKey = /^[0-9a-f]{64}$/.test(value) ? value : '';
  pending = false;
  controls.disabled = !publicKey;
  profileControls.disabled = !publicKey;
  publicControls.disabled = !publicKey;
  element('public-status').textContent = 'No public data request yet.';
  element('public-result').textContent = '';
  element('public-result').dataset.state = 'idle';
  element('profile-status').textContent = 'No profile request yet.';
  element('profile-result').textContent = '';
  element('profile-result').dataset.state = 'idle';
  element('identity').textContent = publicKey;
  element('identity-status').textContent = publicKey ? 'Identity connected' : 'No identity selected';
  element('result').textContent = '';
  element('result').dataset.state = 'idle';
  element('key-list').replaceChildren();
  element('status').textContent = 'No request yet.';
}
async function connectIdentity(): Promise<void> {
  let changed = false;
  try {
    const sub = identity.onChanged(value => {
      if (disposed) return;
      changed = true;
      acceptIdentity(value);
    });
    window.addEventListener('pagehide', () => { disposed = true; identityEpoch++; controls.disabled = true; profileControls.disabled = true; publicControls.disabled = true; sub.close(); });
    const initial = await identity.getPublicKey();
    if (!changed && !disposed) acceptIdentity(initial);
  } catch {
    if (!changed && !disposed) {
      controls.disabled = true;
      element('identity-status').textContent = 'Open in a shell with identity and storage access';
    }
  }
}

type Action = 'read' | 'write' | 'remove' | 'keys';
async function run(action: Action): Promise<void> {
  if (pending || !publicKey || disposed) return;
  const epoch = identityEpoch;
  const api = scopeInput.value === 'instance' ? storage.instance : storage;
  const key = keyInput.value;
  const value = valueInput.value;
  pending = true;
  controls.disabled = true;
  element('status').textContent = 'Waiting for the shell…';
  element('requests').textContent = String(++requests);
  const current = (): boolean => !disposed && epoch === identityEpoch;
  try {
    if (action === 'read') {
      const saved = await api.getItem(key);
      if (!current()) return;
      element('result').dataset.state = saved === null ? 'missing' : 'present';
      element('result').textContent = saved ?? '';
      element('status').textContent = saved === null ? 'No value saved.' : saved === '' ? 'Read an empty string.' : 'Read complete.';
    } else if (action === 'keys') {
      const keys = await api.keys();
      if (!current()) return;
      element('key-list').replaceChildren(...keys.map(key => {
        const row = document.createElement('li'); row.textContent = key; return row;
      }));
      element('status').textContent = `${keys.length} saved keys.`;
    } else {
      if (action === 'write') await api.setItem(key, value);
      else await api.removeItem(key);
      if (!current()) return;
      element('status').textContent = action === 'write' ? 'Write confirmed.' : 'Remove confirmed.';
      element('result').dataset.state = 'idle';
      element('result').textContent = '';
    }
  } catch (error) {
    if (!current()) return;
    element('result').dataset.state = 'error';
    element('status').textContent = 'Request failed: ' + (error instanceof Error ? error.message.slice(0, 240) : 'storage unavailable');
  } finally {
    if (current()) { pending = false; controls.disabled = !publicKey; }
  }
}
for (const action of ['read', 'write', 'remove', 'keys'] as const) {
  element(action).addEventListener('click', () => { void run(action); });
}
element('title').textContent = __LAB_TITLE__;
document.title = __LAB_TITLE__;
element('lab').dataset.ready = 'true';
void connectIdentity();
void connectTheme();

async function readProfile(): Promise<void> {
  if (!publicKey || disposed || profileControls.disabled) return;
  const epoch = identityEpoch;
  const current = (): boolean => !disposed && epoch === identityEpoch;
  profileControls.disabled = true;
  element('profile-status').textContent = 'Reading public profile…';
  try {
    const profile = await identity.getProfile();
    if (!current()) return;
    element('profile-result').dataset.state = profile === null ? 'missing' : 'present';
    element('profile-result').textContent = JSON.stringify(profile);
    element('profile-status').textContent = profile === null ? 'No public profile found.' : 'Profile read complete.';
  } catch (error) {
    if (!current()) return;
    element('profile-result').dataset.state = 'error';
    element('profile-result').textContent = '';
    element('profile-status').textContent = 'Profile read failed: ' + (error instanceof Error ? error.message.slice(0, 240) : 'identity unavailable');
  } finally { if (current()) profileControls.disabled = !publicKey; }
}
element('profile-read').addEventListener('click', () => { void readProfile(); });

const publicReads = {
  relays: () => identity.getRelays(), follows: () => identity.getFollows(),
  mutes: () => identity.getMutes(), badges: () => identity.getBadges(),
  blocked: () => identity.getBlocked(), zaps: () => identity.getZaps(),
  list: () => identity.getList(element<HTMLSelectElement>('list-type').value),
};
async function readPublic(kind: keyof typeof publicReads): Promise<void> {
  if (!publicKey || disposed || publicControls.disabled) return;
  const epoch = identityEpoch, current = () => !disposed && epoch === identityEpoch;
  publicControls.disabled = true;
  element('public-status').textContent = 'Reading public ' + kind + '…';
  element('public-result').textContent = '';
  try {
    const value = await publicReads[kind]();
    if (!current()) return;
    element('public-result').dataset.state = 'present';
    element('public-result').textContent = JSON.stringify(value);
    element('public-status').textContent = 'Public ' + kind + ' read complete.';
  } catch (error) {
    if (!current()) return;
    element('public-result').dataset.state = 'error';
    element('public-status').textContent = 'Public ' + kind + ' read failed: ' + (error instanceof Error ? error.message.slice(0, 240) : 'identity unavailable');
  } finally {if (current()) publicControls.disabled = !publicKey;}
}
for (const kind of Object.keys(publicReads) as (keyof typeof publicReads)[]) {
  element('public-' + kind).addEventListener('click', () => {void readPublic(kind);});
}
