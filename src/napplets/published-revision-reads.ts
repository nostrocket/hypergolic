import { downloadPublishedArtifact, PublishedLoadError, resolvePublishedManifest, type PublishedLoadOptions } from './loader.ts';
import { verifiedPublicationIdentity } from './verified-publication-identity.ts';
import { assertVerifiedArtifact, retainPublishedArtifact, releasePublishedArtifact, type VerifiedNappletArtifact, type VerifiedNappletManifest } from './verified-artifact.ts';

type Authority = { user: string; epoch: number; assertActive(): void };
type ReadCache = (authority: Authority, publisher: string, appId: string, eventId: string,
  signal: AbortSignal, assertActive: () => void) => Promise<VerifiedNappletArtifact | null>;
type Flight = {controller: AbortController; consumers: number; result: Promise<VerifiedNappletArtifact>};

function revisionKey(authority: Authority, manifest: VerifiedNappletManifest): string {
  return JSON.stringify([authority.user, authority.epoch, manifest.pubkey, verifiedPublicationIdentity(manifest).appId,
    manifest.eventId, manifest.expectedHtmlHash, manifest.aggregateHash]);
}

function matches(artifact: VerifiedNappletArtifact, manifest: VerifiedNappletManifest): boolean {
  assertVerifiedArtifact(artifact);
  return artifact.manifest.pubkey === manifest.pubkey && artifact.manifest.eventId === manifest.eventId &&
    verifiedPublicationIdentity(artifact.manifest).appId === verifiedPublicationIdentity(manifest).appId &&
    artifact.htmlHash === manifest.expectedHtmlHash && artifact.aggregateHash === manifest.aggregateHash;
}

/** A cancelled catalog request cannot receive a result or cancel a concurrent Settings request. */
function subscribe(flight: Flight, signal: AbortSignal, retire: () => void): Promise<VerifiedNappletArtifact> {
  flight.consumers++;
  return new Promise((resolve, reject) => {
    let done = false;
    function leave(): boolean {
      if (done) return false;
      done = true;
      signal.removeEventListener('abort', abort);
      if (--flight.consumers === 0) retire();
      return true;
    }
    function abort(): void { if (leave()) reject(new PublishedLoadError()); }
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    flight.result.then(value => {
      if (done) return;
      try {
        const owned = retainPublishedArtifact(value);
        leave();
        resolve(owned);
      } catch (error) { leave(); reject(error); }
    }, error => { if (leave()) reject(error); });
  });
}

export function createPublishedRevisionReads(readCache: ReadCache) {
  const flights = new Map<string, Flight>();
  const held = new Map<string, {eventId: string; count: number; reference?: WeakRef<VerifiedNappletArtifact>}>();
  return {
    hold(authority: Authority, artifact: VerifiedNappletArtifact) {
      const key = revisionKey(authority, artifact.manifest);
      const entry = held.get(key) ?? {eventId: artifact.manifest.eventId, count: 0};
      if (typeof WeakRef !== 'undefined') entry.reference = new WeakRef(artifact);
      entry.count++;
      held.set(key, entry);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--entry.count === 0) held.delete(key);
      };
    },
    protectedEvents: () => new Set([...held.values()].map(entry => entry.eventId)),
    async load(link: string, options: PublishedLoadOptions, authority: Authority): Promise<VerifiedNappletArtifact> {
      const active = () => {
        if (options.signal.aborted) throw new PublishedLoadError();
        authority.assertActive();
        options.assertActive();
      };
      active();
      const manifest = await resolvePublishedManifest(link, options);
      active();
      const key = revisionKey(authority, manifest);
      const live = held.get(key)?.reference?.deref();
      if (live && matches(live, manifest)) {
        try { return retainPublishedArtifact(live); } catch { /* A mounted guest may already have released its file handle. */ }
      }
      let flight = flights.get(key);
      if (!flight) {
        const controller = new AbortController();
        const signal = controller.signal;
        const assertActive = () => { if (signal.aborted) throw new PublishedLoadError(); authority.assertActive(); };
        const read = async () => {
          const stored = await readCache(authority, manifest.pubkey, verifiedPublicationIdentity(manifest).appId,
            manifest.eventId, signal, assertActive);
          if (stored) {
            try { assertActive(); if (matches(stored, manifest)) return stored; }
            catch (error) { releasePublishedArtifact(stored); throw error; }
            releasePublishedArtifact(stored);
          }
          assertActive();
          return downloadPublishedArtifact(manifest, {source: options.source, signal, assertActive});
        };
        flight = {controller, consumers: 0, result: read()};
        flights.set(key, flight);
      }
      const shared = flight;
      const artifact = await subscribe(shared, options.signal, () => {
        if (flights.get(key) === shared) flights.delete(key);
        shared.controller.abort();
        void shared.result.then(releasePublishedArtifact, () => {});
      });
      try { active(); return artifact; }
      catch (error) { releasePublishedArtifact(artifact); throw error; }
    },
  };
}
