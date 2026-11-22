import {run} from 'node:test';
import {fileURLToPath} from 'node:url';

// These named production-component tests already have fixtures for the shell's selected profile.
export const componentCases = [
  ['common-identifiers','COMMON','runtime/common-read','Common public NIP-19 helpers round trip all six types without using a secret'],
  ['cvm-message','CVM','cvm/contract','all MCP forms preserve payload, typed IDs and immutable capture'],
  ['link-result','LINK','network/link-contract','canonical results require captured correlation, exact status and denial-only optional error'],
  ['lists-add','LISTS','runtime/lists-preparation','standard list preparation accepts an ordinary published caller with both grants and authenticates its captured owner'],
  ['notify-permission','NOTIFY','presentation/notify','notification needs focused trusted permission and original correlated result'],
  ['outbox-route','OUTBOX','outbox/read-service','author query routes to signed write relay independently of configured Network and read role'],
  ['resource-bulk','RESOURCE','network/resource-transfer','bulk adapter preserves exact order, canonical per-item errors and complete Blobs'],
  ['storage-missing','STORAGE','storage/storage','missing, empty string and removed values stay distinct, including restart and closed sessions'],
  ['upload-request','UPLOAD','network/upload','selected draft wire accepts upload without info preflight and preserves all fields'],
];

export async function runComponent(file, name) {
  const path = fileURLToPath(new URL('../../tests/' + file + '.test.ts', import.meta.url));
  const matches = [];
  for await (const {type, data} of run({files:[path], testNamePatterns:[name], timeout:30000})) {
    if (type === 'test:fail') throw new Error(data.details.error?.message ?? 'Component fixture failed');
    if (type === 'test:pass' && data.name === name && !data.skip && !data.todo) matches.push(data.name);
  }
  if (matches.length !== 1) throw new Error('Expected exactly one executed component case: ' + name);
  return true;
}
