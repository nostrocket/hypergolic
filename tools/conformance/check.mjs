import {execFileSync} from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { observations } from './observations.mjs';
import { observeFirstThemeRequest, observeHost } from './host.mjs';
import { rules } from './rules.mjs';
import { assess, gate, markdown } from './report.mjs';
import specs from './specs.json' with {type:'json'};
import {runComponent} from './component-cases.mjs';

const {values} = parseArgs({options:{strict:{type:'boolean'}, json:{type:'string'}, markdown:{type:'string'}}});
const checks = {...observations, 'cleartext-publication':() => runComponent('security/approval', 'Relay and Outbox refuse encrypted guest content before review')};
for (const engine of ['chromium', 'webkit']) {
  let snapshot, earlySnapshot;
  const observe = () => snapshot ??= observeHost(engine);
  const beforeReady = () => earlySnapshot ??= observeFirstThemeRequest(engine);
  checks[engine + '-first-domain-call'] = async () => (await beforeReady()).first;
  checks[engine + '-early-discovery'] = async () => (await beforeReady()).beforeShellInit;
  checks[engine + '-environment'] = async () => (await observe()).exposesTheme;
  checks[engine + '-sandbox'] = async () => (await observe()).sandbox === 'allow-scripts';
  checks[engine + '-srcdoc'] = async () => (await observe()).srcdoc;
  checks[engine + '-hello'] = async () => {
    const {messages, portThemeReply} = await observe();
    return portThemeReply && messages.length === 1 && messages[0].type === 'napplet.hello' && messages[0].ports === 1;
  };
}
const results = await assess(rules, checks, specs);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const report = markdown(results) + '\nImplementation commit: `' + revision + '`\n';
process.stdout.write(report);
if (values.json) await writeFile(values.json, JSON.stringify({version:1, revision, specs, results}, null, 2) + '\n');
if (values.markdown) await writeFile(values.markdown, report);
if (!gate(results, values.strict)) process.exitCode = 1;
