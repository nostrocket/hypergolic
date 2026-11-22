import {createHash} from 'node:crypto';
import {rules} from './rules.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import specs from './specs.json' with {type:'json'};

// Resolve each branch once, then compare immutable file blobs. Other changes in a repo are irrelevant.
export async function compareSpecs(catalog, request) {
  const heads = new Map();
  const changes = [];
  for (const [name, {repo, path, revision, ref}] of Object.entries(catalog)) {
    const key = repo + ':' + ref;
    if (!heads.has(key)) heads.set(key, (await request(repo + '/commits/' + encodeURIComponent(ref))).sha);
    const head = heads.get(key);
    if (![head, revision].every(sha => /^[0-9a-f]{40}$/.test(sha))) throw new Error('Invalid revision for ' + name);
    if (head === revision) continue;
    const file = repo + '/contents/' + path;
    const old = await request(file + '?ref=' + revision);
    const current = await request(file + '?ref=' + head, {allowMissing:true});
    if (!/^[0-9a-f]{40}$/.test(old.sha) || (current && !/^[0-9a-f]{40}$/.test(current.sha))) throw new Error('Invalid blob for ' + name);
    if (old.sha !== current?.sha) changes.push({name, repo, path, revision, head, removed:!current});
  }
  return changes;
}

async function github(resource, {allowMissing = false} = {}) {
  const headers = {Accept:'application/vnd.github+json'};
  if (process.env.GH_TOKEN) headers.Authorization = 'Bearer ' + process.env.GH_TOKEN;
  const response = await fetch('https://api.github.com/repos/' + resource, {headers, signal:AbortSignal.timeout(20000)});
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw new Error('Upstream read failed (' + response.status + ') for ' + resource);
  return response.json();
}

const title = 'Review upstream NIP-5D and NAP specification changes';
export function driftReport(changes) {
  return ['The scheduled comparison found changes to the following pinned specification files.', '',
    ...changes.map(c => {
      const base = 'https://github.com/' + c.repo;
      const fragment = '#diff-' + createHash('sha256').update(c.path).digest('hex');
      const affected = rules.filter(rule => rule.spec === c.name).map(rule => rule.id);
      return '- **' + c.name + '** · [pinned text](' + base + '/blob/' + c.revision + '/' + c.path +
        ') · [' + (c.removed ? 'file removed at head' : 'upstream text') + '](' + base +
        (c.removed ? '/tree/' + c.head : '/blob/' + c.head + '/' + c.path) + ') · [compare](' + base + '/compare/' + c.revision + '...' + c.head + fragment + ') · rules: ' + affected.join(', ');
    }), '', 'Review the affected requirements and fixtures, then advance the relevant pins in a pull request.'].join('\n');
}

async function track(changes) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required for --track');
  // Match this bot-owned issue only. Do not rewrite a maintainer's issue with a similar title.
  const gh = args => execFileSync('gh', [...args, '--repo', repo], {encoding:'utf8'}).trim();
  const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp',
    'repos/' + repo + '/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100'], {encoding:'utf8'}));
  const issues = pages.flat().filter(row => !row.pull_request);
  const existing = issues.find(issue => issue.title === title);
  if (!changes.length) {
    if (existing) gh(['issue','close',String(existing.number),'--comment','The watched specification files now match the reviewed pins.']);
    return;
  }
  const body = driftReport(changes);
  if (existing?.body.trim() === body.trim()) return;
  const dir = await mkdtemp(join(tmpdir(), 'protocol-drift-'));
  try {
    const file = join(dir, 'issue.md');
    await writeFile(file, body);
    gh(existing ? ['issue','edit',String(existing.number),'--body-file',file] : ['issue','create','--title',title,'--body-file',file]);
  } finally {await rm(dir, {recursive:true, force:true});}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {values} = parseArgs({options:{track:{type:'boolean'}}});
  const changes = await compareSpecs(specs, github);
  process.stdout.write((changes.length ? driftReport(changes) : 'All watched specification files match their pins.') + '\n');
  if (values.track) await track(changes);
}
