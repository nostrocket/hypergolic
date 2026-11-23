import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
// The fixtures contain heterogeneous, blob-pinned protocol messages. Individual probes
// decode the operation they exercise and assert its complete observable response.
type Fields = Record<string, any>;
type Step = {index: number; input: Fields; outputs: Fields[]};
const pins: Record<string, Record<'in' | 'out', string>> = JSON.parse(readFileSync(new URL('./fixtures/blobs.json', import.meta.url), 'utf8'));

export function readBlob<T>(url: URL, digest: string): T[] {
  const bytes = readFileSync(url);
  const hash = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  assert.equal(hash, digest, 'Reviewed Git blob changed: ' + url.pathname.split('/').pop());
  return bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}

export function loadTrace(name: string) {
  const read = (suffix: 'in' | 'out') => readBlob<Fields>(new URL('./fixtures/' + name + '.' + suffix + '.ndjson', import.meta.url), pins[name][suffix]);
  const [header, ...inputs] = read('in');
  const outputs = read('out');
  assert.equal(outputs.length, inputs.length);
  const steps: Step[] = inputs.map((input, index) => {
    assert.equal(outputs[index].step, index);
    return {index, input, outputs: outputs[index].outputs};
  });
  return {header, steps};
}

export function sends(step: Step): {port: number; msg: Fields}[] {
  return step.outputs.filter(output => output.t === 'send').map(({port, msg}) => ({port, msg}));
}

// Unspecified error prose must still be a readable string on both sides.
export function readableError(message: object): Fields {
  if (!('error' in message)) return {...message};
  assert.ok(typeof message.error === 'string' && message.error.trim());
  return {...message, error: '<explanation>'};
}
