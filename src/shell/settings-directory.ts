export const roomTitles = {
  'open-napplet': 'Open a napplet',
  identity: 'Identity',
  'device-privacy': 'Device privacy',
  connections: 'Connections',
  access: 'Napplet access',
  developer: 'Developer tools',
  about: 'About Hypergolic',
  relays: 'Relays',
  downloads: 'Download servers',
  uploads: 'File uploads',
} as const;

export type SettingsRoom = keyof typeof roomTitles;

export interface RoomLink {
  room: SettingsRoom;
  detail?: string;
  accent?: boolean;
}

export const connectionLinks: readonly RoomLink[] = [
  {room: 'relays'}, {room: 'downloads'}, {room: 'uploads'},
];

export function parentRoom(room: SettingsRoom): 'connections' | 'index' {
  return connectionLinks.some(link => link.room === room) ? 'connections' : 'index';
}

export function settingsLinks({identities, lock, published, developer, version}: {
  identities: number; lock: boolean | undefined; published: boolean; developer: boolean; version: string;
}): RoomLink[] {
  const rows: RoomLink[] = [];
  if (published) rows.push({room: 'open-napplet', detail: 'Named address or snapshot link'});
  const privacy = lock === undefined ? 'Workspace lock and signing confirmation'
    : lock ? 'Lock on · Unlocks on launch' : 'Lock off';
  rows.push(
    {room: 'identity', detail: `${identities} saved ${identities === 1 ? 'identity' : 'identities'} · Signing and backup`},
    {room: 'device-privacy', detail: privacy, accent: lock === true},
    {room: 'connections', detail: 'Relays, downloads and file uploads'},
    {room: 'access', detail: 'Notifications, public lists and handlers'},
  );
  if (developer) rows.push({room: 'developer', detail: 'Test napplets and compatibility'});
  rows.push({room: 'about', detail: `Version ${version}`});
  return rows;
}
