/** NAP-LISTS app-curation profile: one public address in the user's named napplets list. */
export const APP_CURATION_LIST = Object.freeze({
  kind: 30267, type: 'app-curation-sets', addressable: true,
  supportedItemTypes: ['address'], privateItems: false,
});
export const LIST_PREPARE = 'lists.prepareRecommendation';
export const LIST_PUBLICATION_PREFIX = 'lists-publish-';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function listHeader(value: unknown) {
  if (!isRecord(value) || !['lists.supported', 'lists.add', 'lists.remove'].includes(String(value.type)) ||
      typeof value.id !== 'string' || !/^[!-~]{1,128}$/u.test(value.id)) return null;
  return {type: String(value.type), id: value.id};
}

type Addition = {error: string} | {coordinate: string; create: boolean};
export function recommendationAddition(message: Record<string, unknown>): Addition {
  const {list, items, options} = message;
  if (!isRecord(list) || Object.hasOwn(list, 'kind') === Object.hasOwn(list, 'type')) return {error: 'invalid-list-ref'};
  if (list.kind !== APP_CURATION_LIST.kind && list.type !== APP_CURATION_LIST.type) return {error: 'unsupported-list'};
  if (!list.identifier) return {error: 'missing-identifier'};
  if (list.identifier !== 'napplets') return {error: 'unsupported-list'};
  if (Object.keys(list).length !== 2 || Object.keys(message).some(key => !['type', 'id', 'list', 'items', 'options'].includes(key))) {
    return {error: 'invalid-list-ref'};
  }
  if (options !== undefined && (!isRecord(options) || Object.keys(options).some(key => key !== 'create') ||
      'create' in options && typeof options.create !== 'boolean')) return {error: 'unsupported'};
  if (message.type !== 'lists.add') return {error: 'unsupported'};
  if (!Array.isArray(items) || items.length !== 1 || !isRecord(items[0])) return {error: 'invalid-item'};

  const item = items[0];
  if (item.visibility === 'private') return {error: 'private-items-unsupported'};
  if (item.itemType !== 'address' || Object.keys(item).some(key => !['itemType', 'value', 'visibility'].includes(key)) ||
      item.visibility !== undefined && item.visibility !== 'public') return {error: 'unsupported-item'};
  if (typeof item.value !== 'string' || item.value.length > 512 || !/^35129:[a-f0-9]{64}:.+$/u.test(item.value) ||
      /[\u0000-\u001f\u007f]/u.test(item.value)) return {error: 'invalid-item'};
  return {coordinate: item.value, create: isRecord(options) && options.create === true};
}
