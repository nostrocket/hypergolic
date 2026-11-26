import type {ShellDatabase} from '../storage/database.ts';
import type {NativeRegistration} from '../runtime/capability-protocol.ts';
import {DIRECTORY, FILE_OPERATIONS, virtualName} from './documents.ts';
import {filePicker} from './file-picker.ts';

export async function dispatchFile(database: ShellDatabase, registration: NativeRegistration, request: Record<string,unknown>, active: () => void) {
  const operation = String(request.type).slice(3);
  if (!FILE_OPERATIONS.some(method => method === operation)) return {error:'unsupported'};
  if (!database.document) return {error:'io-error'};
  const owner = {...registration,assertActive:active};
  if (operation !== 'pickFile' && operation !== 'pickSaveFile') return database.document(owner,request);
  if (Object.keys(request).some(key => !['type','id','options'].includes(key)) ||
      (request.options !== undefined && (!request.options || typeof request.options !== 'object' || Array.isArray(request.options)))) return {error:'invalid-data'};
  const save = operation === 'pickSaveFile';
  const options = request.options as {suggestedName?: unknown; permissions?: unknown} | undefined;
  const permissions = options?.permissions ?? (save ? ['write','create'] : ['read']);
  const offered = new Set(save ? ['write','create'] : ['read']);
  if (!Array.isArray(permissions) || !permissions.every(p => offered.has(p))) return {error:'permission-denied'};
  const {entries} = await database.document(owner,{type:'fs.list',path:DIRECTORY});
  if (!Array.isArray(entries)) return {error:'io-error'};
  const names = entries.map(entry => String(entry.name));
  const hint = options?.suggestedName;
  const suggestedName = typeof hint === 'string' && validName(hint) ? hint : 'Untitled.txt';
  const name = await filePicker.choose({app:registration.appId,save,names,suggestedName},active);
  active();
  if (name === null) return {error:'cancelled'};
  if (!validName(name)) return {error:'invalid-path'};
  const path = DIRECTORY + '/' + name;
  if (!save && !(await database.document(owner,{type:'fs.stat',path})).metadata) return {error:'not-found'};
  return {result:{entries:[{path,name,kind:'file',permissions}]}};
}
function validName(name: string) { return !!name && virtualName(DIRECTORY + '/' + name) === name; }
