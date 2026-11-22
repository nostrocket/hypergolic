const issueRoot = 'https://github.com/nostrocket/hypergolic/issues/';
const gates = new Set(['pass', 'known gap', 'reviewed gap']);

export function classify(observation, issue) {
  if (observation === true) return issue ? 'retire baseline' : 'pass';
  if (observation === false) return issue ? 'known gap' : 'regression';
  if (observation === 'reviewed' && issue) return 'reviewed gap';
  throw new Error('Missing or invalid observation');
}

export async function assess(rules, checks, specs) {
  const expected = rules.map(rule => rule.id);
  if (expected.length === 0 || expected.length !== new Set(expected).size ||
      Object.keys(checks).length !== expected.length || expected.some(id => typeof checks[id] !== 'function')) {
    throw new Error('Rule catalog and executable inventory disagree');
  }
  const results = [];
  for (const rule of rules) {
    const {repo, path, revision} = specs[rule.spec];
    const source = 'https://github.com/' + repo + '/blob/' + revision + '/' + path + (rule.section ? '#' + rule.section : '');
    try {
      results.push({...rule, source, status:classify(await checks[rule.id](), rule.issue)});
    } catch (error) {
      results.push({...rule, source, status:'check error', detail:String(error.message ?? error)});
    }
  }
  return results;
}

export function gate(results, strict = false) {
  return results.length > 0 && results.every(r => strict ? r.status === 'pass' : gates.has(r.status));
}

export function markdown(results) {
  const tracked = new Set(results.filter(r => ['known gap','reviewed gap'].includes(r.status)).map(r => r.issue));
  const summary = results.filter(r => r.status === 'pass').length + ' passing checks · ' + tracked.size + ' distinct tracked issues';
  const rows = results.map(r => '| ' + [r.status, r.id, '[' + r.title + '](' + r.source + ')',
    r.issue ? '[#' + r.issue + '](' + issueRoot + r.issue + ')' : '—'].join(' | ') + ' |');
  return ['## Shell conformance', '', summary, '', '| Result | Rule | Requirement | Issue |', '|---|---|---|---|',
    ...rows, '', ...results.filter(r => r.detail).map(r => '- ' + r.id + ' — ' + r.detail.replaceAll('\n', ' ')), ''].join('\n');
}
