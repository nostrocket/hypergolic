import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('bundled Support napplet reads live report, filters, expands and has no file/media authority', async ({page}, testInfo) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    (window as any).HypergolicHost = {postMessage: () => undefined};
  });
  await page.goto('/assets/runtime/index.html?sessionId=support-test&fixture=nap-support');
  const frame = page.frames().find(value => value.parentFrame());
  if (!frame) throw new Error('Missing support frame');
  await expect(frame.locator('#host')).toContainText('Hypergolic');
  await expect(frame.locator('#naps > li')).toHaveCount(35);
  await expect(frame.locator('li[data-domain="fs"] .support')).toHaveText('✕Unavailable');
  await expect(frame.locator('li[data-domain="media"] .support')).toHaveText('✕Unavailable');
  await expect(frame.locator('li[data-domain="resource"] .support')).toHaveText('✓Available');
  await expect(frame.locator('li[data-domain="outbox"] .support')).toHaveText('✓Available');
  await expect(frame.locator('.legend')).toContainText('not full conformance');
  await frame.locator('li[data-domain="relay"] summary').click();
  await expect(frame.locator('li[data-domain="relay"] .detail')).toContainText('Encrypted publication is unavailable');
  await expect(frame.locator('li[data-domain="relay"] .detail')).toContainText('Shell-reported');
  await frame.getByLabel('Find a NAP').fill('fs');
  await expect(frame.locator('#naps > li')).toHaveCount(1);
  await frame.locator('summary').click();
  await expect(frame.locator('details')).toHaveAttribute('open', '');
  await expect(frame.locator('.detail')).toContainText('b640cf337c0481f0f9a0216c00843f797a5c6df6');
  await page.screenshot({path: `/tmp/hg-nap-availability-fix/fs-${testInfo.project.name}.png`});
  await frame.getByLabel('Find a NAP').fill('');
  await frame.getByRole('button', {name: 'Available', exact: true}).click();
  await expect(frame.locator('li[data-domain="fs"]')).toHaveCount(0);
  await frame.getByRole('button', {name: 'All', exact: true}).click();
  await page.screenshot({path: `/tmp/hg-nap-availability-fix/catalogue-${testInfo.project.name}.png`});
  const result = await frame.evaluate(async () => {
    const target = window as any;
    await target.napplet.shell.ready();
    return {fs: target.napplet.shell.supports('fs'), media: target.napplet.shell.supports('media'),
      identity: target.napplet.shell.supports('identity'), domains: Object.isFrozen(target.hypergolicSupportReport.domains),
      bridge: typeof target.HypergolicHost, writable: Object.getOwnPropertyDescriptor(window, 'hypergolicSupportReport')?.writable};
  });
  expect(result).toEqual({fs: false, media: false, identity: false, domains: true, bridge: 'undefined', writable: false});
});

test('fallback discovery reports scoped availability without claiming global absence', async ({page}) => {
  await page.addInitScript(() => {
    (window as any).napplet = {shell: {ready: () => Promise.resolve({}), supports: (domain: string) => domain === 'theme'}};
  });
  await page.goto('about:blank');
  await page.setContent(readFileSync('fixtures/nap-support.html', 'utf8'));
  await expect(page.locator('#host')).toContainText('Availability for this napplet');
  await expect(page.locator('li[data-domain="theme"] .support')).toHaveText('✓Available');
  await expect(page.locator('li[data-domain="shell"] .support')).toHaveText('✓Available');
  await expect(page.locator('li[data-domain="fs"] .support')).toHaveText('✕Not offered');
  await page.locator('li[data-domain="fs"] summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('li[data-domain="fs"] details')).toHaveAttribute('open', '');
  await expect(page.locator('li[data-domain="fs"] .detail')).toContainText('may not have granted');
  await page.getByRole('button', {name: 'Not offered', exact: true}).click();
  await expect(page.locator('li[data-domain="theme"]')).toHaveCount(0);
});

test('missing or failed discovery is Unknown and never grouped as unavailable', async ({page}) => {
  await page.setContent(readFileSync('fixtures/nap-support.html', 'utf8'));
  await expect(page.locator('#host')).toContainText('No shell environment');
  await expect(page.locator('li[data-domain="fs"] .support')).toHaveText('?Unknown');
  await page.getByRole('button', {name: 'Unavailable', exact: true}).click();
  await expect(page.locator('#naps > li')).toHaveCount(0);
  await page.getByRole('button', {name: 'Unknown', exact: true}).click();
  await expect(page.locator('#naps > li')).toHaveCount(35);
  await page.addInitScript(() => {
    (window as any).napplet = {shell: {ready: () => Promise.reject(new Error('no environment')), supports: () => false}};
  });
  await page.goto('about:blank');
  await page.setContent(readFileSync('fixtures/nap-support.html', 'utf8'));
  await expect(page.locator('#host')).toContainText('discovery failed');
  await expect(page.locator('li[data-domain="fs"] .support')).toHaveText('?Unknown');
});

test('a late handshake replaces Unknown rather than leaving a false absence result', async ({page}) => {
  await page.addInitScript(() => {
    (window as any).finishSupportDiscovery = undefined;
    (window as any).napplet = {shell: {ready: () => new Promise(resolve => {(window as any).finishSupportDiscovery = resolve;}), supports: () => false}};
  });
  await page.goto('about:blank');
  await page.setContent(readFileSync('fixtures/nap-support.html', 'utf8'));
  await expect(page.locator('li[data-domain="fs"] .support')).toHaveText('?Unknown');
  await expect(page.locator('#host')).toContainText('has not completed', {timeout: 6000});
  await page.evaluate(() => (window as any).finishSupportDiscovery({}));
  await expect(page.locator('li[data-domain="fs"] .support')).toHaveText('✕Not offered');
});
