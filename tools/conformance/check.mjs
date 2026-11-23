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
  let snapshot;
  const observe = () => snapshot ??= observeHost(engine);
  checks[engine + '-first-domain-call'] = () => observeFirstThemeRequest(engine);
  checks[engine + '-early-discovery'] = async () => (await observe()).beforeShellInit;
  checks[engine + '-environment'] = async () => (await observe()).exposesTheme;
  checks[engine + '-sandbox'] = async () => (await observe()).sandbox === 'allow-scripts';
  checks[engine + '-srcdoc'] = async () => (await observe()).srcdoc;
  checks[engine + '-hello'] = async () => {
    const messages = (await observe()).messages;
    return messages.length === 1 && messages[0].type === 'napplet.hello' && messages[0].ports === 1;
  };
}
const results = await assess(rules, checks, specs);
const compatibility = [];
for (const [id, title, name] of [
  ['legacy-direct-open', 'Opening an older release by address prompts even with an existing grant', 'legacy format review cannot reuse a grant replaced while the prompt is open'],
  ['legacy-saved-pin', 'An exact verified saved release reopens with its approved grant', 'only explicit trusted review persists the exact publisher, signed coordinate and capabilities'],
]) {
  try {
    await runComponent('napplets/first-open-consent', name);
    compatibility.push({id, title, issue:104, status:'pass'});
  } catch (error) {
    compatibility.push({id, title, issue:104, status:'regression', detail:String(error.message ?? error)});
  }
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const report = markdown(results) + '\n## Hypergolic compatibility policy\n\n' + compatibility.map(row => '- ' + row.status + ' — ' + row.title + (row.detail ? ' — ' + row.detail : '')).join('\n') + '\n' + '\nImplementation commit: `' + revision + '`\n';
process.stdout.write(report);
if (values.json) await writeFile(values.json, JSON.stringify({version:1, revision, specs, results, profiles:{strict:{passed:gate(results, true)}, compatibility:{passed:gate(compatibility), results:compatibility}}}, null, 2) + '\n');
if (values.markdown) await writeFile(values.markdown, report);
if (!gate(results, values.strict) || !gate(compatibility)) process.exitCode = 1;
