import { upload } from '@napplet/sdk';
import './style.css';
import originalJpeg from './public-synthetic-photo.jpeg?url&inline';
import originalHeic from './public-synthetic-photo.heic?url&inline';
function element<T extends HTMLElement>(id: string): T {const value = document.getElementById(id); if (!value) throw Error('Missing upload control'); return value as T;}
const request = element<HTMLButtonElement>('request'), inspect = element<HTMLButtonElement>('inspect'), status = element('status'), receipt = element('receipt');
let uploadId: string | null = null, busy = false;
const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=';
const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
element<HTMLImageElement>('preview').src = 'data:image/png;base64,' + encoded;
function render(value: unknown): void {receipt.textContent = JSON.stringify(value, null, 2);}
request.addEventListener('click', () => {
  if (busy) return; busy = true; request.disabled = true; status.textContent = 'Waiting for trusted review…';
  void upload.upload({data: new Blob([bytes], {type: 'image/png'}), filename: 'two-pixels.png', caption: 'Generated red and green PNG', noTransform: true, metadata: {fixture: 'upload-lab'}})
    .then(value => {uploadId = value.uploadId; render(value); status.textContent = 'Upload pending approval.';})
    .catch(error => {status.textContent = error instanceof Error ? error.message : 'Upload request failed.';})
    .finally(() => {busy = false; request.disabled = false;});
});
inspect.addEventListener('click', () => {if (uploadId) void upload.status(uploadId).then(render).catch(() => {status.textContent = 'Upload status unavailable.';});});
let subscription: ReturnType<typeof upload.onStatus> | null = null;
try {subscription = upload.onStatus(value => {render(value); status.textContent = 'Upload ' + value.status + '.';});}
catch {status.textContent = 'Upload status notifications are unavailable in this host.';}
window.addEventListener('pagehide', () => {subscription?.close(); bytes.fill(0);}, {once: true});
status.textContent = 'Ready to request a PNG upload.';

const selection = element<HTMLInputElement>('selection'), selectedRequest = element<HTMLButtonElement>('selected-request'), selectedRead = element<HTMLButtonElement>('selected-read'), selectedStatus = element('selected-status');
let selected: File | null = null;
async function readSelected(): Promise<void> {
  if (!selected) return;
  const data = await selected.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
  selectedStatus.textContent = 'Selected bytes: ' + data.byteLength + '; SHA-256: ' + hash + '; type: ' + selected.type + '; name: ' + selected.name + '; relative path: ' + selected.webkitRelativePath;
}
selection.addEventListener('change', () => {
  selected = selection.files?.length === 1 ? selection.files[0]! : null;
  selectedRequest.disabled = selected === null; selectedRead.disabled = selected === null;
  if (selected) void readSelected().catch(() => {selectedStatus.textContent = 'Selected file unavailable.';});
});
selectedRead.addEventListener('click', () => {void readSelected().catch(() => {selectedStatus.textContent = 'Selected file unavailable.';});});
selectedRequest.addEventListener('click', () => {
  if (busy || !selected) return;
  busy = true; selectedRequest.disabled = true; status.textContent = 'Waiting for trusted review…';
  void upload.upload({data: selected, filename: selected.name, caption: 'Selected file', noTransform: true})
    .then(value => {uploadId = value.uploadId; render(value); status.textContent = 'Upload pending approval.';})
    .catch(error => {status.textContent = error instanceof Error ? error.message : 'Upload request failed.';})
    .finally(() => {busy = false; selectedRequest.disabled = selected === null;});
});


// Guest-owned originals deliberately bypass native system selection. Native upload
// preparation must still remove metadata before its trusted exact-byte review.
for (const photo of [{kind: 'JPEG', mime: 'image/jpeg', asset: originalJpeg}, {kind: 'HEIC', mime: 'image/heic', asset: originalHeic}]) {
  const button = element<HTMLButtonElement>('original-' + photo.kind.toLowerCase());
  button.addEventListener('click', () => {
    if (busy) return;
    busy = true; button.disabled = true; status.textContent = 'Waiting for trusted original-photo review…';
    const data = Uint8Array.from(atob(photo.asset.slice(photo.asset.indexOf(',') + 1)), character => character.charCodeAt(0));
    void (async () => {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
      element('original-status').textContent = 'Original ' + photo.kind + ' input: ' + data.byteLength + ' bytes; SHA-256: ' + hash;
      const value = await upload.upload({data: new Blob([data], {type: photo.mime}), filename: 'generated-original.' + photo.kind.toLowerCase(), caption: 'Generated original ' + photo.kind, noTransform: true});
      uploadId = value.uploadId; render(value); status.textContent = 'Upload pending approval.';
    })().catch(error => {status.textContent = error instanceof Error ? error.message : 'Original photo request failed.';})
      .finally(() => {data.fill(0); busy = false; button.disabled = false;});
  });
}

// Public deterministic attachment gives the native fault driver a bounded streaming interval.
const largeRequest = element<HTMLButtonElement>('large-request');
largeRequest.addEventListener('click', () => {
  if (busy) return;
  busy = true; largeRequest.disabled = true; status.textContent = 'Waiting for trusted attachment review…';
  const data = new Uint8Array(4 * 1024 * 1024); data.fill(97);
  const header = new DataView(data.buffer);
  const ascii = (offset: number, value: string): void => {for (let index = 0; index < value.length; index++) data[offset + index] = value.charCodeAt(index);};
  ascii(0, 'RIFF'); header.setUint32(4, data.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
  header.setUint32(24, 8000, true); header.setUint32(28, 8000, true); header.setUint16(32, 1, true); header.setUint16(34, 8, true);
  ascii(36, 'data'); header.setUint32(40, data.length - 44, true);
  void upload.upload({data: new Blob([data], {type: 'audio/wav'}), filename: 'generated-four-megabytes.wav', caption: 'Generated public WAV fixture', noTransform: true})
    .then(value => {uploadId = value.uploadId; render(value); status.textContent = 'Upload pending approval.';})
    .catch(error => {status.textContent = error instanceof Error ? error.message : 'Attachment request failed.';})
    .finally(() => {data.fill(0); busy = false; largeRequest.disabled = false;});
});

// The reserved unsigned queue artifact opts in through a reviewed body attribute.
// Requests use the genuine SDK; nothing can publish without a native review.
if (document.body.dataset.uploadQueue === 'true') {
  const attachment = new Blob(['Generated public queue fixture.\n'], {type: 'text/plain'});
  const queued = () => upload.upload({data: attachment, filename: 'generated-queue.txt', noTransform: true});
  setTimeout(() => {void queued().then(value => {
    uploadId = value.uploadId; render(value);
    return queued().then(() => {status.textContent = 'Unexpected second queue admission.';})
      .catch(error => {status.textContent = 'Queue pending; second request rejected: ' + (error instanceof Error ? error.message : 'unknown');});
  }).catch(error => {status.textContent = 'Queue request rejected: ' + (error instanceof Error ? error.message : 'unknown');});}, 500);
}

// Allows a real loaded peer to stage its own SDK request while another is focused.
element<HTMLButtonElement>('scheduled-request').addEventListener('click', () => {
  status.textContent = 'PNG request scheduled in fifteen seconds.';
  setTimeout(() => request.click(), 15000);
});

// Advisory discovery never authorizes an upload or starts provider networking.
element<HTMLButtonElement>('info-request').addEventListener('click', () => {
  void upload.info().then(value => {element('upload-info').textContent = JSON.stringify(value, null, 2);})
    .catch(() => {element('upload-info').textContent = 'Upload limits unavailable.';});
});
