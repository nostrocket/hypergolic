import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';


type FixtureState = { calls: unknown[]; fail: boolean; defer: boolean; closed: number;
  publicFail: boolean; publicDefer: boolean; publicReply(value: unknown): void;
  profileValue: {name?: string; displayName?: string} | null; profileFail: boolean; profileDefer: boolean;
  pushIdentity(value: string): void; identity(value: string): void; read(value: string): void;
  pushTheme(value: unknown): void; theme(value: unknown): void; profile(value: {name: string}): void };
type FixtureWindow = Window & {fixtureTest: FixtureState};

const build = (peer = false) => new URL(peer ? '../dist-peer/' : '../dist/', import.meta.url);
const html = (peer = false) => readFileSync(new URL('index.html', build(peer)), 'utf8');
const first = 'a'.repeat(64), second = 'b'.repeat(64);
const dark = { colors: { background: '#140f0b', text: '#f3efeb', primary: '#e8805d' } };
const light = { colors: { background: '#ffffff', text: '#17212b', primary: '#b84421' } };
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">`;
// Test-only SDK adapter. This proves fixture behavior, not NAP or native authority.
function adapter(mode: string): string {
  return `<script>
  const calls = [], maps = { shared: new Map(), instance: new Map() };
  let identityChanged = () => {}, themeChanged = () => {};
  let resolveIdentity, resolveTheme, resolveRead, resolveProfile, resolvePublic;
  const state = { publicFail:false, publicDefer:false, publicReply: value => resolvePublic(value), fail: false, defer: false, closed: 0, calls,
    pushIdentity: value => identityChanged(value), pushTheme: value => themeChanged(value),
    identity: value => resolveIdentity(value), theme: value => resolveTheme(value),
    profileValue: {name: "Public \\u003cscript>text\\u003c/script>", displayName: "雪"}, profileFail: false, profileDefer: false,
    profile: value => resolveProfile(value), read: value => resolveRead(value) };
  const scope = name => ({
    getItem: async key => { calls.push(['get', name, key]); if (state.fail) throw new Error('read unavailable'); if(state.defer) return new Promise(resolve => { resolveRead = resolve; }); return maps[name].get(key) ?? null; },
    setItem: async (key,value) => { calls.push(['set', name, key, value]); if(state.fail) throw new Error('quota exceeded'); maps[name].set(key,value); },
    removeItem: async key => { calls.push(['remove', name, key]); maps[name].delete(key); },
    keys: async () => { calls.push(['keys', name]); return [...maps[name].keys()]; }
  });
  window.napplet = {
    identity: {
      ...Object.fromEntries(['getRelays','getFollows','getMutes','getBadges','getBlocked','getZaps','getList'].map(method => [method, async argument => {
        calls.push([method,argument ?? null]); if(state.publicFail)throw new Error('public read denied');if(state.publicDefer)return new Promise(resolve => {resolvePublic=resolve;});
        if(method==='getBlocked'||method==='getZaps'||argument==='unsupported')throw new Error('unsupported');
        return method==='getRelays'?{'wss://literal.example':{read:true,write:false}}:method==='getBadges'?[{id:'b'.repeat(64),awardedBy:'c'.repeat(64),name:'<literal>'}]:['literal <tag>',argument ?? method];
      }])),
      getProfile: async () => { if (state.profileFail) throw new Error("relay unavailable"); if (state.profileDefer) return new Promise(resolve => {resolveProfile = resolve;}); return state.profileValue; },
      getPublicKey: () => ${mode === 'delayIdentity' ? 'new Promise(resolve => { resolveIdentity = resolve; })' : 'Promise.resolve(' + JSON.stringify(mode === 'signedOut' ? '' : first) + ')'},
      onChanged: handler => { identityChanged = handler; return { close: () => { state.closed++; identityChanged = () => {}; } }; }
    },
    ${mode === 'noStorage' ? '' : 'storage: { ...scope("shared"), instance: scope("instance") },'}
    theme: {
      get: () => ${mode === 'delayTheme' ? 'new Promise(resolve => { resolveTheme = resolve; })' : 'Promise.resolve(' + JSON.stringify(light) + ')'},
      onChanged: handler => { themeChanged = handler; return { close: () => { state.closed++; themeChanged = () => {}; } }; }
    }
  };
  window.fixtureTest = state;
  </script>`;
}
async function mount(page: Page, mode = 'normal', peer = false): Promise<FrameLocator> {
  await page.setContent('<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;position:fixed;inset:0}</style>');
  const source = html(peer).replace('<head>', '<head>' + csp + (mode === 'absent' ? '' : adapter(mode)));
  await page.evaluate(source => {
    const frame = document.createElement('iframe'); frame.id = 'fixture'; frame.title = 'State Lab fixture';
    frame.sandbox.add('allow-scripts'); frame.srcdoc = source; document.body.append(frame);
  }, source);
  const frame = page.frameLocator('#fixture');
  await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready', 'true');
  if (!['absent', 'delayIdentity', 'signedOut'].includes(mode)) await expect(frame.getByTestId('identity')).toHaveText(first);
  return frame;
}
const control = async (frame: FrameLocator, action: string, expected: string) => {
  await frame.getByTestId(action).click();
  await expect(frame.getByTestId('status')).toHaveText(expected);
};

for (const peer of [false, true]) test(`artifact ${peer ? 'peer' : 'primary'} has only inline assets and exact unsigned required-domain metadata`, () => {
  expect(readdirSync(build(peer)).sort()).toEqual(['.nip5a-manifest.json', 'index.html']);
  const manifest = JSON.parse(readFileSync(new URL('.nip5a-manifest.json', build(peer)), 'utf8'));
  const digest = createHash('sha256').update(html(peer)).digest('hex');
  const aggregate = createHash('sha256').update(digest + ' /index.html\n').digest('hex');
  expect(manifest.kind).toBe(35129);
  expect(manifest.tags).toContainEqual(['d', peer ? 'state-lab-peer' : 'state-lab']);
  expect(manifest.tags.filter((tag: string[]) => tag[0] === 'path')).toEqual([['path', '/index.html', digest]]);
  expect(manifest.tags).toContainEqual(['x', aggregate, 'aggregate']);
  expect(manifest.aggregateHash).toBe(aggregate);
  expect(manifest.tags.filter((tag: string[]) => tag[0] === 'requires')).toEqual([['requires', 'identity'], ['requires', 'storage']]);
  expect(manifest).not.toHaveProperty('sig'); expect(manifest).not.toHaveProperty('pubkey');
  expect(html(peer)).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\//i);
  expect(html(peer)).not.toMatch(/\b(?:fetch|WebSocket|localStorage|sessionStorage|indexedDB|XMLHttpRequest)\b|window\.nostr|document\.cookie/);
  expect(html(peer)).not.toContain('fixtureTest');
});

test('all four storage operations use the selected SDK scope; empty differs from missing', async ({ page }) => {
  const frame = await mount(page);
  await control(frame, 'read', 'No value saved.');
  await expect(frame.getByTestId('result')).toHaveAttribute('data-state', 'missing');
  await control(frame, 'write', 'Write confirmed.');
  await control(frame, 'read', 'Read an empty string.');
  await expect(frame.getByTestId('result')).toHaveAttribute('data-state', 'present');
  await frame.getByTestId('scope').selectOption('instance');
  await control(frame, 'read', 'No value saved.');
  await frame.getByTestId('value').fill('instance string');
  await control(frame, 'write', 'Write confirmed.');
  await control(frame, 'keys', '1 saved keys.');
  await expect(frame.getByTestId('key-list')).toHaveText('sample');
  await control(frame, 'read', 'Read complete.');
  await expect(frame.getByTestId('result')).toHaveText('instance string');
  await control(frame, 'remove', 'Remove confirmed.');
  await control(frame, 'keys', '0 saved keys.');
  await frame.getByTestId('scope').selectOption('shared');
  await control(frame, 'read', 'Read an empty string.');
  expect(await frame.locator('body').evaluate(() => (window as unknown as FixtureWindow).fixtureTest.calls)).toEqual([
    ['get', 'shared', 'sample'], ['set', 'shared', 'sample', ''], ['get', 'shared', 'sample'],
    ['get', 'instance', 'sample'], ['set', 'instance', 'sample', 'instance string'], ['keys', 'instance'],
    ['get', 'instance', 'sample'], ['remove', 'instance', 'sample'], ['keys', 'instance'], ['get', 'shared', 'sample'],
  ]);
});

test('saved text and keys remain literal; artifact has no parent access or network traffic', async ({ page }) => {
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => requests.push(request.url())); page.on('pageerror', error => errors.push(error.message));
  const frame = await mount(page);
  const text = '<img src=x onerror="window.attack=true">\n🧪 你好';
  await frame.getByTestId('key').fill('<b>instance:other</b>');
  await frame.getByTestId('value').fill(text);
  await control(frame, 'write', 'Write confirmed.'); await control(frame, 'read', 'Read complete.');
  await expect(frame.getByTestId('result')).toHaveText(text);
  await control(frame, 'keys', '1 saved keys.');
  await expect(frame.getByTestId('key-list')).toHaveText('<b>instance:other</b>');
  await expect(frame.locator('img, b')).toHaveCount(0);
  expect(requests).toEqual([]); expect(errors).toEqual([]);
  expect(await frame.locator('body').evaluate(() => { try { return !!parent.document; } catch { return false; } })).toBe(false);
});

test('failed write and failed read preserve inputs and never report missing or success', async ({ page }) => {
  const frame = await mount(page);
  await frame.getByTestId('value').fill('preserve this');
  await frame.locator('body').evaluate(() => { (window as unknown as FixtureWindow).fixtureTest.fail = true; });
  await control(frame, 'write', 'Request failed: quota exceeded');
  await expect(frame.getByTestId('value')).toHaveValue('preserve this');
  await control(frame, 'read', 'Request failed: read unavailable');
  await expect(frame.getByTestId('result')).toHaveAttribute('data-state', 'error');
  await frame.locator('body').evaluate(() => { (window as unknown as FixtureWindow).fixtureTest.fail = false; });
  await control(frame, 'write', 'Write confirmed.');
});

for (const mode of ['absent', 'signedOut']) test(`${mode} cannot write and keeps a readable explanation`, async ({ page }) => {
  const frame = await mount(page, mode);
  await expect(frame.getByTestId('write')).toBeDisabled();
  await expect(frame.getByTestId('identity-status')).toHaveText(mode === 'absent' ? 'Open in a shell with identity and storage access' : 'No identity selected');
  await expect(frame.getByTestId('requests')).toHaveText('0');
});

test('missing storage fails visibly through the SDK for both scopes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const frame = await mount(page, 'noStorage');
  for (const scope of ['shared', 'instance']) {
    await frame.getByTestId('scope').selectOption(scope); await frame.getByTestId('write').click();
    await expect(frame.getByTestId('status')).toContainText('Request failed:');
  }
  expect(errors).toEqual([]);
});

test('identity push wins over the older startup response', async ({ page }) => {
  const frame = await mount(page, 'delayIdentity');
  await expect(frame.getByTestId('write')).toBeDisabled();
  await frame.locator('body').evaluate((_element, { second, first }) => {
    (window as unknown as FixtureWindow).fixtureTest.pushIdentity(second); (window as unknown as FixtureWindow).fixtureTest.identity(first);
  }, { second, first });
  await expect(frame.getByTestId('identity')).toHaveText(second);
  await expect(frame.getByTestId('write')).toBeEnabled();
});

test('identity change clears results and prevents a late old read repainting them', async ({ page }) => {
  const frame = await mount(page);
  await frame.locator('body').evaluate(() => { (window as unknown as FixtureWindow).fixtureTest.defer = true; });
  await frame.getByTestId('read').click();
  await expect(frame.getByTestId('write')).toBeDisabled();
  await frame.locator('body').evaluate((_element, second) => {
    const state = (window as unknown as FixtureWindow).fixtureTest; state.pushIdentity(second); state.read('old identity value');
  }, second);
  await expect(frame.getByTestId('identity')).toHaveText(second);
  await expect(frame.getByTestId('result')).toHaveText('');
  await expect(frame.getByTestId('result')).toHaveAttribute('data-state', 'idle');
  await frame.locator('body').evaluate(() => (window as unknown as FixtureWindow).fixtureTest.pushIdentity(''));
  await expect(frame.getByTestId('write')).toBeDisabled();
});

test('pushed dark theme wins over delayed light and paints every surface', async ({ page }, testInfo) => {
  const frame = await mount(page, 'delayTheme');
  await frame.locator('body').evaluate((_element, { dark, light }) => {
    (window as unknown as FixtureWindow).fixtureTest.pushTheme(dark); (window as unknown as FixtureWindow).fixtureTest.theme(light);
  }, { dark, light });
  for (const selector of ['html', 'body', '#lab']) await expect(frame.locator(selector)).toHaveCSS('background-color', 'rgb(20, 15, 11)');
  await expect(frame.getByTestId('theme-status')).toHaveText('Host colors');
  await page.screenshot({ path: testInfo.outputPath('state-lab-dark.png') });
  await frame.locator('body').evaluate((_element, light) => (window as unknown as FixtureWindow).fixtureTest.pushTheme(light), light);
  for (const selector of ['html', 'body', '#lab']) await expect(frame.locator(selector)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.screenshot({ path: testInfo.outputPath('state-lab-light.png') });
});

test('pagehide closes subscriptions and rejects later work', async ({ page }) => {
  const frame = await mount(page);
  await frame.locator('body').evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(await frame.locator('body').evaluate(() => (window as unknown as FixtureWindow).fixtureTest.closed)).toBe(2);
  await expect(frame.getByTestId('write')).toBeDisabled();
});

for (const width of [240, 320, 768]) test(`all controls fit at ${width}px and peer identifies itself`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const frame = await mount(page, 'normal', true);
  await expect(frame.locator('h1')).toHaveText('State Lab Peer');
  expect(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await frame.getByTestId('value').fill('small screen');
  await control(frame, 'write', 'Write confirmed.');
  await expect(frame.getByTestId('write')).toBeInViewport();
});

test('profile success, missing and error remain distinct and render untrusted strings literally', async ({page}) => {
  const frame = await mount(page);
  await frame.getByTestId('profile-read').click();
  await expect(frame.getByTestId('profile-status')).toHaveText('Profile read complete.');
  await expect(frame.getByTestId('profile-result')).toHaveText('{"name":"Public <script>text</script>","displayName":"雪"}');
  const owner = page.frames().find(value => value.parentFrame() !== null)!;
  await owner.evaluate(() => { (window as unknown as FixtureWindow).fixtureTest.profileValue = null; });
  await frame.getByTestId('profile-read').click();
  await expect(frame.getByTestId('profile-result')).toHaveAttribute('data-state', 'missing');
  await owner.evaluate(() => { (window as unknown as FixtureWindow).fixtureTest.profileFail = true; });
  await frame.getByTestId('profile-read').click();
  await expect(frame.getByTestId('profile-status')).toHaveText('Profile read failed: relay unavailable');
  await expect(frame.getByTestId('profile-result')).toHaveAttribute('data-state', 'error');
});
test('late profile reply from an earlier identity cannot repaint the new user', async ({page}) => {
  const frame = await mount(page), owner = page.frames().find(value => value.parentFrame() !== null)!;
  await owner.evaluate(() => { (window as unknown as FixtureWindow).fixtureTest.profileDefer = true; });
  await frame.getByTestId('profile-read').click();
  await expect(frame.getByTestId('profile-status')).toHaveText('Reading public profile…');
  await owner.evaluate(value => { (window as unknown as FixtureWindow).fixtureTest.pushIdentity(value); }, second);
  await owner.evaluate(() => { (window as unknown as FixtureWindow).fixtureTest.profile({name:'Old user'}); });
  await expect(frame.getByTestId('identity')).toHaveText(second);
  await expect(frame.getByTestId('profile-result')).toHaveText('');
  await expect(frame.getByTestId('profile-status')).toHaveText('No profile request yet.');
});

for (const [kind,method] of [['relays','getRelays'],['follows','getFollows'],['mutes','getMutes'],['badges','getBadges']] as const) test(`public ${kind} calls the selected SDK method and renders data as literal JSON`,async({page})=>{
 const frame=await mount(page);await frame.locator('#public-'+kind).click();await expect(frame.locator('#public-status')).toHaveText('Public '+kind+' read complete.');
 const calls=await frame.locator('body').evaluate(()=>(window as unknown as FixtureWindow).fixtureTest.calls);expect(calls).toEqual([[method,null]]);
 await expect(frame.locator('#public-result')).toHaveAttribute('data-state','present');await expect(frame.locator('#public-result literal, #public-result tag')).toHaveCount(0);
});
for(const category of ['bookmarks','pins','interests','unsupported'])test(`categorized list forwards exact ${category} and exposes failures distinctly`,async({page})=>{
 const frame=await mount(page);await frame.locator('#list-type').selectOption(category);await frame.locator('#public-list').click();
 await expect(frame.locator('#public-status')).toHaveText(category==='unsupported'?'Public list read failed: unsupported':'Public list read complete.');
 expect(await frame.locator('body').evaluate(()=>(window as unknown as FixtureWindow).fixtureTest.calls)).toEqual([['getList',category]]);
});
test('public list denial, unsupported blocks and deferred zaps never display a successful empty list',async({page})=>{
 const frame=await mount(page);for(const kind of ['blocked','zaps']){await frame.locator('#public-'+kind).click();await expect(frame.locator('#public-result')).toHaveAttribute('data-state','error');}
 await frame.locator('body').evaluate(()=>{(window as unknown as FixtureWindow).fixtureTest.publicFail=true;});await frame.locator('#public-mutes').click();
 await expect(frame.locator('#public-status')).toHaveText('Public mutes read failed: public read denied');await expect(frame.locator('#public-result')).toHaveText('');
});
for(const change of ['identity','pagehide'])test(`late public data is ignored after ${change}`,async({page})=>{
 const frame=await mount(page);await frame.locator('body').evaluate(()=>{(window as unknown as FixtureWindow).fixtureTest.publicDefer=true;});await frame.locator('#public-mutes').click();
 await frame.locator('body').evaluate((_node,change)=>{const state=(window as unknown as FixtureWindow).fixtureTest;if(change==='identity')state.pushIdentity('b'.repeat(64));else window.dispatchEvent(new PageTransitionEvent('pagehide'));state.publicReply(['old account']);},change);
 await expect(frame.locator('#public-result')).toHaveText('');
});
