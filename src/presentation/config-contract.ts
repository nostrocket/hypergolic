import {routingPayload, routingRecord, routingText} from '../routing/routing-contract.ts';
import type {ConfigValues} from './config-schema.ts';
export type ConfigMessage = Readonly<{type: 'config.registerSchema'; id: string; schema: unknown; version?: number}>
 | Readonly<{type: 'config.get'; id: string}> | Readonly<{type: 'config.subscribe' | 'config.unsubscribe'}> | Readonly<{type: 'config.openSettings'; section?: string}>;
export function parseConfigMessage(input: unknown): ConfigMessage {
  const row = routingRecord(routingPayload(input), ['type'], ['id', 'schema', 'version', 'section']);
  if (row.type === 'config.registerSchema') {
    routingRecord(row, ['type', 'id', 'schema'], ['version']); routingText(row.id, 128);
    if ('version' in row && (!Number.isSafeInteger(row.version) || (row.version as number) < 0 || (row.version as number) > 4_294_967_295)) throw new Error('Invalid schema version');
  } else if (row.type === 'config.get') {routingRecord(row, ['type', 'id']); routingText(row.id, 128);}
  else if (row.type === 'config.subscribe' || row.type === 'config.unsubscribe') routingRecord(row, ['type']);
  else if (row.type === 'config.openSettings') {routingRecord(row, ['type'], ['section']); if ('section' in row) routingText(row.section, 128);}
  else throw new Error('Unknown configuration operation');
  return row as ConfigMessage;
}
const codes = new Set(['invalid-schema', 'unsupported-draft', 'ref-not-allowed', 'pattern-not-allowed', 'secret-with-default', 'schema-too-deep', 'version-conflict', 'no-schema']);
export function captureConfigPush(input: unknown): Readonly<Record<string, unknown> & {type: string}> {
  const row = routingRecord(routingPayload(input), ['type'], ['values', 'code', 'error']);
  if (row.type === 'config.values') {routingRecord(row, ['type', 'values']); routingRecord(row.values, [], Object.keys(row.values as object));}
  else if (row.type === 'config.schemaError') {routingRecord(row, ['type', 'code', 'error']); if (!codes.has(row.code as string)) throw new Error('Invalid schema error'); routingText(row.error, 256);}
  else throw new Error('Invalid configuration push');
  return row as Readonly<Record<string, unknown> & {type: string}>;
}
export function captureConfigReply(input: unknown, request: ConfigMessage): Readonly<Record<string, unknown> & {type: string}> | null {
  if (!('id' in request)) {if (input !== null) throw new Error('Unexpected config receipt'); return null;}
  const row = routingRecord(routingPayload(input), ['type', 'id'], ['ok', 'values', 'code', 'error']);
  if (row.id !== request.id) throw new Error('Config response mismatch');
  if (request.type === 'config.registerSchema') {
    routingRecord(row, ['type', 'id', 'ok'], ['code', 'error']);
    if (row.type !== 'config.registerSchema.result' || typeof row.ok !== 'boolean') throw new Error('Invalid config ACK');
    if (row.ok) {if ('code' in row || 'error' in row) throw new Error('Invalid config ACK');}
    else {if (!codes.has(row.code as string)) throw new Error('Invalid schema error'); routingText(row.error, 256);}
  } else {
    if (row.type !== 'config.values') throw new Error('Invalid config snapshot'); routingRecord(row, ['type', 'id', 'values']); routingRecord(row.values as ConfigValues, [], Object.keys(row.values as object));
  }
  return row as Readonly<Record<string, unknown> & {type: string}>;
}
