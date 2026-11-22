export type PresentationPin = Readonly<{
  published: boolean;
  appId: string;
  eventId?: string;
  aggregateHash: string;
}>;

// Each signed event ID commits to the publisher and the complete manifest.
const releases = [
  {appId: 'emoji-browser',
    eventId: '215099f7b55eb6cf0ec945f77b8c259f4a899b469f0b297f19df395cf9ec20fd',
    aggregateHash: '24b16ab3eb550d50eff01a3c42c6e56c3a81da4cf6914b11dc766d8575767381'},
  {appId: 'creator-signals',
    eventId: 'c05896275c4bd64890117e0ac5897331626829fad9b5d7e9c1b253d3c3ca4e1a',
    aggregateHash: 'a3320b9d78a3506bca07cb3ffcc09c2db3f36e5493574834c3cb14fc96ebac58'},
  {appId: 'mapplets',
    eventId: '5554f5f5588da293c977c74bf276438e35cf9a1476ff130f4c664702e682ce25',
    aggregateHash: '3a5eeb98b3251a48a3ff1e32cb92ce76b7488b721dd492ae1659e90eeffe76f5'},
  {appId: 'feed-builder',
    eventId: '2f7e777131a6f7ab8b4ecb1a000c970584ea7bbe567a27be143115960268a257',
    aggregateHash: 'a45d5c2ad7316386e9604f0502c7b053be7d2a0b2f1ca8a941e74a1dd72c7754'},
  {appId: 'emoji-pack-creator',
    eventId: 'f38225422900e11bc99360c19066580bd3dc067d86971d01feedc624ca47e600',
    aggregateHash: '1533e892517b313b316b6137759580cbae0a82ca1c9d1de23f6b2f0f2dea6dea'},
] as const;
type ReviewedApp = typeof releases[number]['appId'];

export function reviewedPresentationApp(pin: PresentationPin): ReviewedApp | undefined {
  if (!pin.published) return undefined;
  return releases.find(release => release.eventId === pin.eventId &&
    release.appId === pin.appId && release.aggregateHash === pin.aggregateHash)?.appId;
}
