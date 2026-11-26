import {base64} from '@scure/base';
import type {Access} from '../storage/connection.ts';
import type {TrustedApp} from '../storage/ports.ts';

export const DIRECTORY = '/Documents';
const CHUNK = 128 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const WHERE_OWNER = 'user = ? AND publisher = ? AND app = ?';
export const FILE_OPERATIONS = ['info', 'list', 'stat', 'read', 'write', 'pickFile', 'pickSaveFile'] as const;
const permissions = ['read', 'list', 'write', 'create'];
type Row = {name: string; bytes: Uint8Array; revision: number; modified: number};
type Failure = {error: string};
type Fields = Record<string, unknown>;
const record = (v: unknown): v is Fields => !!v && typeof v === 'object' && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function keys(input: Fields, allowed: string[]): boolean {
  const fields = new Set(allowed);
  return Object.keys(input).every(key => fields.has(key));
}
export function virtualName(path: unknown): string | Failure {
  if (typeof path !== 'string' || path.length > 300 || !path.startsWith('/') || /[\\\p{Cc}\p{Cf}]/u.test(path)) return {error:'invalid-path'};
  if (path === '/') return '';
  const parts = path.normalize('NFC').split('/').slice(1);
  if (parts.some(part => !part || part === '.' || part === '..' || /^[a-z]:/i.test(part))) return {error:'invalid-path'};
  if (parts[0] !== 'Documents' || parts.length > 2) return {error:'not-found'};
  return parts[1] ?? '';
}
function decode(data: unknown): Uint8Array | Failure {
  if (typeof data !== 'string') return {error:'invalid-data'};
  if (data.length > Math.ceil(CHUNK / 3) * 4) return {error:'too-large'};
  try {
    const binary = base64.decode(data);
    if (binary.length > CHUNK) return {error:'too-large'};
    if (base64.encode(binary) !== data) return {error:'invalid-data'};
    return binary;
  } catch { return {error:'invalid-data'}; }
}
const metadata = (name: string, size: number, modified: number) =>
  ({path: DIRECTORY + '/' + name, name, kind:'file', size, modifiedAt:modified});
export async function documentOperation(io: Access, owner: TrustedApp, input: Fields): Promise<Fields> {
  const scope = [owner.user, owner.publisher, owner.appId];
  const root = {path:DIRECTORY, name:'Documents', permissions};
  if (input.type === 'fs.info') return {info:{roots:[root], limits:{maxReadBytes:CHUNK, maxWriteBytes:CHUNK, maxWatchCount:0}}};
  if (!['fs.read','fs.write','fs.list','fs.stat'].includes(String(input.type))) return {error:'unsupported'};
  const allowed = ['id','type','path'];
  if (input.type === 'fs.read' || input.type === 'fs.write') allowed.push('options');
  if (input.type === 'fs.write') allowed.push('data');
  if (!keys(input,allowed)) return {error:'invalid-data'};
  const name = virtualName(input.path);
  if (typeof name !== 'string') return name;
  if (input.type === 'fs.list' && input.path === '/') return {entries:[{path:DIRECTORY,name:'Documents',kind:'directory'}]};
  if (!name) {
    if (input.type === 'fs.stat') return {metadata:{path:input.path,kind:'directory',permissions}};
    if (input.type !== 'fs.list') return {error:'not-a-file'};
    const rows = await io.all<{name:string; size:number; modified:number}>(
      'SELECT name, length(bytes) AS size, modified FROM documents WHERE ' + WHERE_OWNER + ' ORDER BY name', ...scope);
    return {entries:rows.map(row => metadata(row.name,row.size,row.modified))};
  }
  const [row] = await io.all<Row>('SELECT * FROM documents WHERE ' + WHERE_OWNER + ' AND name = ?', ...scope, name);
  const options = input.options === undefined ? {} : input.options;
  if (!record(options)) return {error:'invalid-data'};
  if (input.type === 'fs.write') return writeDocument(io, scope, name, row, options, input.data);
  if (!row) return {error:'not-found'};
  if (input.type === 'fs.stat') {
    const {name: _name, ...file} = metadata(name,row.bytes.length,row.modified);
    return {metadata:{...file,revision:String(row.revision),permissions:['read','write']}};
  }
  if (input.type === 'fs.list') return {error:'not-a-directory'};
  if (input.type !== 'fs.read') return {error:'unsupported'};
  const {offset = 0, length = CHUNK} = options;
  if (!keys(options,['offset','length']) || !uint(offset) || !uint(length)) return {error:'invalid-data'};
  if (length > CHUNK) return {error:'too-large'};
  const bytes = row.bytes.subarray(offset, offset + length);
  return {result:{data:base64.encode(bytes),offset,bytesRead:bytes.length,eof:offset + bytes.length >= row.bytes.length,size:row.bytes.length}};
}

async function writeDocument(io: Access, scope: string[], name: string, row: Row | undefined, options: Fields, data: unknown): Promise<Fields> {
  const {mode = 'replace', offset, ifRevision, ifAbsent} = options;
  if (!keys(options,['mode','offset','ifRevision','ifAbsent']) ||
      (mode !== 'replace' && mode !== 'append' && mode !== 'patch') ||
      (mode === 'patch' ? !uint(offset) : offset !== undefined) ||
      (ifAbsent !== undefined && typeof ifAbsent !== 'boolean') || (ifRevision !== undefined && typeof ifRevision !== 'string')) return {error:'invalid-data'};
  if ((ifAbsent && row) || (ifRevision !== undefined && (!row || String(row.revision) !== ifRevision))) return {error:'conflict'};
  const incoming = decode(data);
  if (!(incoming instanceof Uint8Array)) return incoming;
  const previous = row?.bytes.length ?? 0;
  const start = mode === 'append' ? previous : typeof offset === 'number' ? offset : 0;
  const size = mode === 'replace' ? incoming.length : Math.max(previous,start + incoming.length);
  if (size > MAX_FILE) return {error:'too-large'};
  const [usage] = await io.all<{files:number; total:number}>(
    'SELECT count(*) AS files, coalesce(sum(length(bytes)),0) AS total FROM documents WHERE ' + WHERE_OWNER, ...scope);
  if (!usage || (!row && usage.files >= 128) || usage.total - previous + size > MAX_FILE * 4) return {error:'quota-exceeded'};
  const bytes = new Uint8Array(size);
  if (row && mode !== 'replace') bytes.set(row.bytes);
  bytes.set(incoming,start);
  await io.run('INSERT INTO documents (user,publisher,app,name,bytes,revision,modified) VALUES (?,?,?,?,?,1,?) ON CONFLICT(user,publisher,app,name) DO UPDATE SET bytes=excluded.bytes,revision=documents.revision+1,modified=excluded.modified', ...scope, name, bytes, Date.now());
  return {result:{bytesWritten:incoming.length,size}};
}
