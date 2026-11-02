import { resource, link } from '@napplet/sdk';
import './style.css';
function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id); if (!node) throw Error('Missing resource control'); return node as T;
}
const lab = element('lab'), status = element('status'), receipt = element('receipt'), preview = element('preview'), items = element('items');
const input = element<HTMLInputElement>('url'), urls = element<HTMLTextAreaElement>('urls');
const load = element<HTMLButtonElement>('load'), many = element<HTMLButtonElement>('many'), cancel = element<HTMLButtonElement>('cancel');
let pending: AbortController | null = null, revision = 0, disposed = false;
const releases = new Set<() => void>();
async function holdObjectURL(blob: Blob, assignSource: (url: string) => void): Promise<void> {
  let close!: () => void;
  const released = new Promise<void>(resolve => {close = resolve;});
  const url = URL.createObjectURL(blob);
  releases.add(close);
  try { assignSource(url); await released; }
  finally { URL.revokeObjectURL(url); releases.delete(close); }
}
function ownSource(blob: Blob, target: HTMLImageElement | HTMLMediaElement | HTMLAnchorElement): void {
  void holdObjectURL(blob,url => { if (target instanceof HTMLAnchorElement) target.href = url; else target.src = url; })
    .catch(() => {if (!disposed) status.textContent = 'Preview unavailable.';});
}
function release(): void {
  for (const media of preview.querySelectorAll('audio,video')) (media as HTMLMediaElement).pause();
  preview.replaceChildren();items.replaceChildren();for (const close of releases) close();releases.clear();
}
function controls(): void { load.disabled = many.disabled = pending !== null || disposed;cancel.disabled = pending === null; }
async function hash(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function render(blob: Blob, target: HTMLElement): Promise<void> {
  if (!(blob instanceof Blob)) throw Error('Host did not deliver a Blob');
  if (blob.type.startsWith('image/')) {
    const image = document.createElement('img');image.alt = 'Loaded resource';ownSource(blob,image);target.append(image);await image.decode();
    lab.dataset.rendered = `${image.naturalWidth}x${image.naturalHeight}`;
  } else if (blob.type.startsWith('audio/') || blob.type.startsWith('video/')) {
    const media = document.createElement(blob.type.startsWith('audio/') ? 'audio' : 'video');
    media.controls = true;media.preload = 'metadata';media.setAttribute('playsinline','');ownSource(blob,media);target.append(media);
    const control = document.createElement('button');control.type = 'button';control.textContent = 'Play resource';control.id = 'play-resource';
    control.addEventListener('click',()=>{void media.play().catch(()=>{status.textContent = 'Playback unavailable.';});});
    const state = document.createElement('p');state.id = 'media-state';state.setAttribute('role','status');target.prepend(control,state);
    const report = () => {state.textContent = `Media ${media.paused ? 'paused' : 'playing'} at ${media.currentTime.toFixed(3)} s`;lab.dataset.playback = media.currentTime.toFixed(3);};
    media.addEventListener('timeupdate', report);media.addEventListener('loadedmetadata', report);media.addEventListener('pause',report);media.addEventListener('play',report);
    media.addEventListener('pause',()=>{lab.dataset.paused = 'true';});media.addEventListener('play',()=>{lab.dataset.paused = 'false';});
  } else {
    const link = document.createElement('a');link.textContent = `Attachment: ${blob.type}, ${blob.size} bytes`;ownSource(blob,link);link.download = 'resource';target.append(link);
  }
}
async function run(bulk: boolean): Promise<void> {
  if (pending || disposed) return;
  const controller = new AbortController(), current = ++revision;pending = controller;controls();release();receipt.textContent = '';lab.dataset.state = 'loading';status.textContent = 'Loading…';
  const active = () => {if(disposed || current !== revision || controller.signal.aborted)throw Error('Cancelled');};
  try {
    if (bulk) {
      const result = await resource.bytesMany(urls.value.split('\n').filter(Boolean),{signal:controller.signal});active();
      const rows = await Promise.all(result.map(async item => {
        const row = document.createElement('li');row.textContent = item.ok ? `${item.url}: ${item.blob.type}, ${item.blob.size} bytes` : `${item.url}: ${item.error}`;
        if (item.ok) {row.dataset.hash = await hash(item.blob);row.textContent += `; SHA-256 ${row.dataset.hash}`;}active();return row;
      }));
      active();items.append(...rows);
      status.textContent = `${result.length} bulk results.`;
    } else {
      const blob = await resource.bytes(input.value,{signal:controller.signal});active();const sha256 = await hash(blob);active();
      receipt.textContent = `${blob.type}\n${blob.size} bytes\nSHA-256 ${sha256}`;lab.dataset.hash = sha256;lab.dataset.bytes = String(blob.size);lab.dataset.mime = blob.type;
      await render(blob,preview);active();status.textContent = 'Resource loaded.';
    }
    lab.dataset.state = 'loaded';
  } catch(error) { if(current === revision && !disposed){release();lab.dataset.state = 'error';status.textContent = controller.signal.aborted ? 'Load cancelled.' : `Load failed: ${error instanceof Error ? error.message : 'unavailable'}`;} }
  finally {if(pending === controller)pending = null;controls();}
}
load.addEventListener('click',()=>{void run(false);});many.addEventListener('click',()=>{void run(true);});
cancel.addEventListener('click',()=>{pending?.abort();});
element('clear').addEventListener('click',()=>{revision++;pending?.abort();release();receipt.textContent = '';status.textContent = 'Preview released.';});
element('info').addEventListener('click',()=>{void resource.info().then(info=>{if(!disposed)receipt.textContent = JSON.stringify(info,null,2);}).catch(()=>{if(!disposed)status.textContent = 'Support unavailable.';});});
window.addEventListener('pagehide',()=>{disposed = true;revision++;pending?.abort();release();controls();},{once:true});
lab.dataset.ready = 'true';controls();

const linkInput = element<HTMLInputElement>('link-url'), linkLabel = element<HTMLInputElement>('link-label');
const linkStatus = element('link-status'), linkResult = element('link-result'), linkButton = element<HTMLButtonElement>('open-link');
let linkRevision = 0;
async function openLink(): Promise<void> {
  const current = ++linkRevision; linkButton.disabled = true; linkResult.textContent = ''; linkStatus.textContent = 'Waiting for shell approval…';
  try {
    const result = await link.open(linkInput.value, {label: linkLabel.value});
    if (disposed || current !== linkRevision) return;
    linkResult.textContent = JSON.stringify(result); lab.dataset.linkResult = JSON.stringify(result);
    linkStatus.textContent = result.status === 'opened' ? 'Link handed to your device.' : 'Link opening denied.';
  } catch {if (!disposed && current === linkRevision) linkStatus.textContent = 'Link request unavailable.';}
  finally {if (!disposed && current === linkRevision) linkButton.disabled = false;}
}
linkButton.addEventListener('click', () => {void openLink();});
element('link-flood').addEventListener('click', () => {
  const current = ++linkRevision;
  void Promise.all(Array.from({length: 4}, () => link.open(linkInput.value))).then(results => {
    if (!disposed && current === linkRevision) {linkResult.textContent = JSON.stringify(results); lab.dataset.linkResult = JSON.stringify(results); linkStatus.textContent = 'Four link requests settled.';}
  }).catch(() => {if (!disposed && current === linkRevision) linkStatus.textContent = 'Link request unavailable.';});
});
