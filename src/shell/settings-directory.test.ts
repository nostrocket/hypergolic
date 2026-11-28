import assert from 'node:assert/strict';
import test from 'node:test';
import {connectionLinks, parentRoom, settingsLinks} from './settings-directory.ts';

const development = {identities: 1, lock: true, published: true, developer: true, version: '0.2.0'};

test('settings presents the supported rooms in order and reports confirmed workspace lock state', () => {
  const links = settingsLinks(development);
  assert.deepEqual(links.map(link => link.room), ['open-napplet', 'identity', 'device-privacy', 'connections', 'access', 'developer', 'about']);
  assert.equal(links[1].detail, '1 saved identity · Signing and backup');
  assert.equal(links[2].detail, 'Lock on · Unlocks on launch');
  assert.equal(links[2].accent, true);
  assert.equal(links.at(-1)?.detail, 'Version 0.2.0');
  for (const [lock, detail] of [[false, 'Lock off'], [undefined, 'Workspace lock and signing confirmation']] as const) {
    const privacy = settingsLinks({...development, lock}).find(link => link.room === 'device-privacy');
    assert.equal(privacy?.detail, detail);
    assert.equal(privacy?.accent, false);
  }
});

test('unavailable runtime and developer tools stay out of Settings', () => {
  const links = settingsLinks({...development, identities: 2, developer: false, published: false});
  assert.deepEqual(links.map(link => link.room), ['identity', 'device-privacy', 'connections', 'access', 'about']);
  assert.equal(links[0].detail, '2 saved identities · Signing and backup');
});

test('Back returns each connection editor to its directory, then to Settings', () => {
  assert.deepEqual(connectionLinks.map(link => link.room), ['relays', 'downloads', 'uploads']);
  for (const {room} of connectionLinks) assert.equal(parentRoom(room), 'connections');
  for (const {room} of settingsLinks(development)) assert.equal(parentRoom(room), 'index');
});
