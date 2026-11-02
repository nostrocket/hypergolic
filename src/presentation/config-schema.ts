import {routingPayload} from '../routing/routing-contract.ts';
export type ConfigValue = string | number | boolean | null | readonly ConfigValue[] | {readonly [key: string]: ConfigValue};
export type ConfigValues = Readonly<Record<string, ConfigValue>>;
export type ConfigSchemaCode = 'invalid-schema' | 'unsupported-draft' | 'ref-not-allowed' | 'pattern-not-allowed' | 'secret-with-default' | 'schema-too-deep' | 'version-conflict' | 'no-schema';
export class ConfigSchemaError extends Error {
  readonly code: ConfigSchemaCode;
  constructor(code: ConfigSchemaCode) {super(code); this.code = code;}
}
export const CONFIG_LIMITS = Object.freeze({bytes: 32 * 1024, properties: 128, depth: 4, stringLength: 4096, items: 256, enumValues: 64});
type Kind = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
export interface ConfigSchema {
  readonly type: Kind;
  readonly properties?: Readonly<Record<string, ConfigSchema>>;
  readonly required?: readonly string[];
  readonly items?: ConfigSchema;
  readonly additionalProperties?: boolean;
  readonly default?: ConfigValue;
  readonly enum?: readonly ConfigValue[];
  readonly enumDescriptions?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly title?: string;
  readonly description?: string;
  readonly markdownDescription?: string;
  readonly deprecationMessage?: string;
  readonly format?: string;
  readonly $schema?: string;
  readonly $version?: number;
  readonly 'x-napplet-secret'?: boolean;
  readonly 'x-napplet-section'?: string;
  readonly 'x-napplet-order'?: number;
  readonly [annotation: string]: unknown;
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: ConfigSchemaCode = 'invalid-schema'): never {throw new ConfigSchemaError(code);}
const keywords = new Set(['type', 'properties', 'required', 'items', 'additionalProperties', 'default', 'enum', 'enumDescriptions', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'title', 'description', 'markdownDescription', 'deprecationMessage', 'format', '$schema', '$version']);
function text(value: unknown, maximum: number = CONFIG_LIMITS.stringLength): value is string {return typeof value === 'string' && Array.from(value).length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);}
function canonical(value: ConfigValue): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key] as ConfigValue)).join(',') + '}';
  return JSON.stringify(value);
}
export function configValueValid(schema: ConfigSchema, value: unknown, requireRequired = true): value is ConfigValue {
  let valid = false;
  switch (schema.type) {
    case 'string': valid = text(value) && Array.from(value).length >= (schema.minLength ?? 0) && Array.from(value).length <= (schema.maxLength ?? CONFIG_LIMITS.stringLength); break;
    case 'number': case 'integer': valid = typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity); break;
    case 'boolean': valid = typeof value === 'boolean'; break;
    case 'array': valid = Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? CONFIG_LIMITS.items) && value.length <= CONFIG_LIMITS.items && value.every(item => configValueValid(schema.items!, item)); break;
    case 'object': {
      if (!record(value)) return false;
      const properties = schema.properties!;
      valid = (!requireRequired || (schema.required ?? []).every(key => own(value, key))) && Object.keys(value).every(key => own(properties, key) ? configValueValid(properties[key]!, value[key], requireRequired) : schema.additionalProperties === true);
      break;
    }
  }
  return valid && (!schema.enum || schema.enum.some(item => canonical(item) === canonical(value as ConfigValue)));
}
function boundedInteger(value: unknown, maximum: number): value is number {return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;}
function secretInDefault(schema: ConfigSchema, value: unknown): boolean {
  if (schema['x-napplet-secret'] === true || schema.type === 'array' && schema.items?.['x-napplet-secret'] === true) return value !== undefined;
  if (schema.type !== 'object' || !record(value)) return false;
  return Object.entries(schema.properties!).some(([key, child]) => own(value, key) && secretInDefault(child, value[key]));
}
/** Captures the complete bounded Core Subset; never resolves references or executes guest validation. */
export function captureConfigSchema(input: unknown): ConfigSchema {
  let captured: unknown;
  try {captured = routingPayload(input);} catch {return fail();}
  let properties = 0;
  function node(value: unknown, objectDepth: number, root: boolean): ConfigSchema {
    if (!record(value)) return fail();
    for (const key of Object.keys(value)) {
      if (['$ref', '$defs', 'definitions', '$dynamicRef'].includes(key)) fail('ref-not-allowed');
      if (key === 'pattern' || key === 'patternProperties') fail('pattern-not-allowed');
      if (!keywords.has(key) && !key.startsWith('x-')) fail();
    }
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(value.type as string) || root && value.type !== 'object') fail();
    const schema = value as ConfigSchema;
    if (own(value, '$schema')) {
      if (!root || typeof value.$schema !== 'string' || !/^https?:\/\/json-schema\.org\/(draft-07\/schema|draft\/(2019-09|2020-12)\/schema)#?$/.test(value.$schema)) fail('unsupported-draft');
    }
    if (own(value, '$version') && (!root || !boundedInteger(value.$version, 4_294_967_295))) fail('version-conflict');
    for (const key of ['title', 'description', 'markdownDescription', 'deprecationMessage', 'format', 'x-napplet-section']) if (own(value, key) && !text(value[key])) fail();
    if (own(value, 'x-napplet-order') && (typeof value['x-napplet-order'] !== 'number' || !Number.isFinite(value['x-napplet-order']) || value['x-napplet-order'] < 0)) fail();
    if (own(value, 'x-napplet-secret') && (typeof value['x-napplet-secret'] !== 'boolean' || value['x-napplet-secret'] && schema.type !== 'string')) fail();
    if (schema.type === 'object') {
      if (objectDepth > CONFIG_LIMITS.depth) fail('schema-too-deep');
      if (!record(value.properties)) fail();
      if (own(value, 'additionalProperties') && typeof value.additionalProperties !== 'boolean') fail();
      for (const [key, child] of Object.entries(value.properties)) {
        if (!text(key, 128) || key.length === 0 || ['__proto__', 'constructor', 'prototype'].includes(key) || ++properties > CONFIG_LIMITS.properties) fail();
        node(child, objectDepth + (record(child) && child.type === 'object' ? 1 : 0), false);
      }
      if (own(value, 'required') && (!Array.isArray(value.required) || value.required.length > CONFIG_LIMITS.properties || new Set(value.required).size !== value.required.length || value.required.some(key => typeof key !== 'string' || !own(value.properties as object, key)))) fail();
    } else if (own(value, 'properties') || own(value, 'required') || own(value, 'additionalProperties')) fail();
    if (schema.type === 'array') {
      if (!record(value.items) || !['string', 'number', 'integer', 'boolean'].includes(value.items.type as string)) fail();
      node(value.items, objectDepth, false);
    } else if (own(value, 'items')) fail();
    for (const [low, high, kind, maximum] of [['minLength', 'maxLength', 'string', CONFIG_LIMITS.stringLength], ['minItems', 'maxItems', 'array', CONFIG_LIMITS.items]] as const) {
      for (const key of [low, high]) if (own(value, key) && (schema.type !== kind || !boundedInteger(value[key], maximum))) fail();
      if (own(value, low) && own(value, high) && (value[low] as number) > (value[high] as number)) fail();
    }
    for (const key of ['minimum', 'maximum']) if (own(value, key) && (!['number', 'integer'].includes(schema.type) || typeof value[key] !== 'number' || !Number.isFinite(value[key]))) fail();
    if (own(value, 'minimum') && own(value, 'maximum') && schema.minimum! > schema.maximum!) fail();
    if (own(value, 'enum')) {
      if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > CONFIG_LIMITS.enumValues) fail();
      const withoutEnum = {...schema}; delete withoutEnum.enum;
      if (value.enum.some(item => !configValueValid(withoutEnum, item)) || new Set(value.enum.map(item => canonical(item as ConfigValue))).size !== value.enum.length) fail();
    }
    if (own(value, 'enumDescriptions') && (!schema.enum || !Array.isArray(value.enumDescriptions) || value.enumDescriptions.length !== schema.enum.length || value.enumDescriptions.some(item => !text(item)))) fail();
    if (own(value, 'default')) {
      if (secretInDefault(schema, value.default)) fail('secret-with-default');
      if (!configValueValid(schema, value.default, false)) fail();
    }
    return schema;
  }
  return node(captured, 1, true);
}
function resolve(schema: ConfigSchema, persisted: unknown, inherited: unknown): ConfigValue | undefined {
  if (schema['x-napplet-secret'] === true || schema.type === 'array' && schema.items?.['x-napplet-secret'] === true) return configValueValid(schema, persisted) ? persisted : undefined;
  if (schema.type !== 'object') {
    for (const value of [persisted, schema.default, inherited]) if (value !== undefined && configValueValid(schema, value)) return value;
    return undefined;
  }
  const saved = record(persisted) ? persisted : {};
  const defaults = record(schema.default) ? schema.default : record(inherited) ? inherited : {};
  const result: Record<string, ConfigValue> = {};
  for (const [key, child] of Object.entries(schema.properties!)) {
    const value = resolve(child, own(saved, key) ? saved[key] : undefined, own(defaults, key) ? defaults[key] : undefined);
    if (value !== undefined) Object.defineProperty(result, key, {value, enumerable: true});
  }
  if (Object.keys(result).length === 0 && persisted === undefined && schema.default === undefined && inherited === undefined) return undefined;
  return result;
}
export function resolveConfigValues(schema: ConfigSchema, persisted: unknown): ConfigValues {
  const result = resolve(schema, persisted, undefined) ?? {};
  return routingPayload(result) as ConfigValues;
}
export const configValuesConform = configValueValid;
export type ConfigSecretField = Readonly<{path: readonly string[]; schema: ConfigSchema}>;
export function configSecretFields(schema: ConfigSchema, path: readonly string[] = []): readonly ConfigSecretField[] {
  if (schema['x-napplet-secret'] === true || schema.type === 'array' && schema.items?.['x-napplet-secret'] === true) return [Object.freeze({path: Object.freeze([...path]), schema})];
  if (schema.type !== 'object') return [];
  return Object.entries(schema.properties!).flatMap(([key, child]) => configSecretFields(child, [...path, key]));
}
