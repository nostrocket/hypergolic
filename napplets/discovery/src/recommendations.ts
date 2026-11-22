import { lists, type ListSupport } from '@napplet/sdk';
import type { Publication } from './catalog.ts';
import { glyph, node } from './dom.ts';

const unconfirmed = 'Could not confirm the public recommendation. Check your list before trying again.';
const list = {kind: 30267, identifier: 'napplets'};

export function supportsRecommendations(support: ListSupport[]): boolean {
  return support.some(item => item.kind === list.kind && item.addressable &&
    (item.supportedItemTypes === undefined || item.supportedItemTypes.includes('address')));
}

export function recommendControl(publication: Publication): HTMLElement | null {
  const api = (window as Window & {napplet?: {lists?: typeof lists}}).napplet?.lists;
  if (typeof api?.supported !== 'function' || typeof api.add !== 'function') return null;
  const control = node('div', 'recommend-control');
  const action = node('button', 'recommend-button', 'Recommend publicly');
  action.prepend(glyph('heart'));
  action.type = 'button';
  const status = node('p', 'recommend-status');
  status.setAttribute('role', 'status');
  control.append(action, status);
  control.hidden = true;
  void lists.supported().then(support => {control.hidden = !supportsRecommendations(support);}).catch(() => {});
  action.addEventListener('click', async () => {
    if (action.disabled || control.hidden) return;
    action.disabled = true;
    status.textContent = 'Requesting a public recommendation…';
    try {
      const value = `${publication.signed.event.kind}:${publication.publisher}:${publication.identifier}`;
      const result = await lists.add(list, [{itemType: 'address', value, visibility: 'public'}], {create: true});
      if (result.ok) {
        status.textContent = result.skipped === 1 ? 'Already in your public recommendations.' : 'Added to your public recommendations.';
        return;
      }
      if (result.error === 'publication-result-unknown') {
        status.textContent = unconfirmed;
        return;
      }
      action.disabled = false;
      status.textContent = result.error === 'user-denied' ? 'Recommendation cancelled.' : 'Your shell could not complete the recommendation.';
    } catch {
      status.textContent = unconfirmed;
    }
  });
  return control;
}
