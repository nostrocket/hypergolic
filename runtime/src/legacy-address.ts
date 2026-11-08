import {decode, naddrEncode} from 'nostr-tools/nip19';
export type LegacyArticle = Readonly<{kind: 30023; pubkey: string; identifier: string; address: string}>;
export function captureLegacyArticle(input: string): LegacyArticle {
  if (new TextEncoder().encode(input).length > 2048) throw new Error('Address is too long');
  const value = input.trim().replace(/^nostr:/, '');
  if (!/^naddr1[0-9a-z]+$/.test(value)) throw new Error('Enter a Nostr article address starting with naddr1.');
  const result = decode(value);
  if (result.type !== 'naddr' || result.data.kind !== 30023 || !/^[a-f0-9]{64}$/.test(result.data.pubkey)) throw new Error('This address is not a Nostr article.');
  const {pubkey, identifier} = result.data;
  if (!identifier || new TextEncoder().encode(identifier).length > 255 || /[\u0000-\u001f\u007f\ufffd]/.test(identifier)) throw new Error('This article address is invalid.');
  return Object.freeze({kind: 30023, pubkey, identifier, address: naddrEncode({kind: 30023, pubkey, identifier})});
}
export function createLegacyAddressControl(labelText: string, open: (article: LegacyArticle) => string | void, clear?: () => void) {
  const details = document.createElement('details'), summary = document.createElement('summary');
  summary.id = 'legacy-article-toggle'; summary.textContent = labelText;
  details.style.cssText = 'flex:none;background:#17202a;color:white;font:12px system-ui';
  summary.style.cssText = 'padding:10px 12px;min-height:24px;cursor:pointer';
  details.append(summary);
  const form = document.createElement('form'), label = document.createElement('label');
  const input = document.createElement('input'), button = document.createElement('button'), feedback = document.createElement('p');
  label.textContent = labelText; input.id = 'legacy-article-address'; label.htmlFor = input.id;
  input.type = 'text'; input.maxLength = 2048; input.placeholder = 'naddr1… or nostr:naddr1…'; input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'none'); input.spellcheck = false;
  button.id = 'legacy-article-open'; button.type = 'submit'; button.textContent = 'Open'; feedback.setAttribute('role', 'status');
  form.style.cssText = 'flex:none;padding:8px 12px;font:12px system-ui;display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#17202a;color:white';
  label.style.cssText = 'width:100%'; input.style.cssText = 'flex:1;min-width:120px;max-width:100%;min-height:44px;box-sizing:border-box;font:16px system-ui';
  button.style.cssText = 'min-height:44px;padding:8px 12px'; feedback.style.cssText = 'margin:0;width:100%;min-width:0;overflow-wrap:anywhere';
  form.append(label, input, button, feedback);
  if (clear) {
    const reset = document.createElement('button'); reset.id = 'legacy-article-clear'; reset.type = 'button'; reset.textContent = 'Clear selection'; reset.style.cssText = 'min-height:44px;padding:8px 12px';
    reset.addEventListener('click', () => {try {clear(); input.value = ''; feedback.textContent = 'Showing the recipe feed.';} catch (error) {feedback.textContent = error instanceof Error ? error.message : 'Reader is not active';}});
    form.append(reset);
  }
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    try {const article = captureLegacyArticle(input.value); const message = open(article); input.value = article.address; feedback.textContent = message ?? 'Opening article…';}
    catch (error) {feedback.textContent = error instanceof Error ? error.message : 'Article address denied';}
  };
  form.addEventListener('submit', submit);
  details.append(form);
  return {element: details, delivered() {feedback.textContent = '';}, close() {form.removeEventListener('submit', submit); details.remove();}};
}
