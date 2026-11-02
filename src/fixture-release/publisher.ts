import { SigningForeground, signingHandoffState, type SigningHandoffReader } from '../security/signing-handoff.ts';
import type { NativeSigningSource } from '../security/native-vault-contract.ts';
import {naddrEncode} from 'nostr-tools/nip19';
import {BUNDLED_FIXTURES} from '../runtime/bundled-catalog.ts';
import {captureEventSnapshot, type EventSnapshot} from '../security/event-snapshot.ts';
import {validateSignedEvent, type VerifiedSignedEvent} from '../security/signed-event.ts';
import type {EffectAuthority} from '../security/approval-service.ts';
import {captureUploadSnapshot, type UploadSnapshot} from '../uploads/upload-snapshot.ts';
import {captureUploadAuthorization} from '../uploads/upload-authorization.ts';
import {normalizeUploadServer} from '../uploads/upload-contract.ts';
import {normalizeRelayUrl} from '../network/relay-settings.ts';
import type {RelayOutcome} from '../network/relay-service.ts';
import type {PublishedArtifactSource} from '../napplets/loader.ts';

export interface FixtureReleasePort {
  synchronizeFixturePublisher(user: string, epoch: number, available: boolean): void;
  prepareFixtureUpload(fixture: string, server: string): string;
  approveFixtureUpload(token: string): boolean;
  isFixtureUploadApproved(token: string): boolean;
  putFixtureUpload(token: string, credential: string): Promise<string>;
  prepareFixtureManifest(token: string, relays: readonly string[]): string;
  approveFixtureManifest(token: string): string | null;
  isFixtureManifestApproved(token: string): boolean;
  cancelFixtureRelease(): void;
}
export interface FixturePublisherEffects extends SigningHandoffReader {
  owner(): Readonly<{user: string; epoch: number; assertActive(): void}>;
  hash(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  now(): number;
  signUpload(snapshot: UploadSnapshot, authority: EffectAuthority): Promise<unknown>;
  signManifest(snapshot: EventSnapshot, authority: EffectAuthority): Promise<unknown>;
  publish(event: VerifiedSignedEvent, relays: readonly string[], authority: EffectAuthority): Promise<readonly RelayOutcome[]>;
  source: PublishedArtifactSource;
}
export type FixtureReleaseReview = Readonly<{fixture: string; identity: string; server: string; sha256: string; size: number;
  mimeType: 'text/html'; relays: readonly string[]; event?: EventSnapshot}>;
export type FixturePublisherState = Readonly<{phase: 'idle'|'preparing'|'upload-review'|'uploading'|'manifest-review'|'publishing'|'complete'|'failed';
  review: FixtureReleaseReview | null; result: string}>;
type Pending = {token: string; bytes: Uint8Array<ArrayBuffer>; review: FixtureReleaseReview;
  owner: ReturnType<FixturePublisherEffects['owner']>; abort: AbortController; signingSource: NativeSigningSource | null; manifest: EventSnapshot | null};
const deny = (): never => {throw new Error('Fixture release denied');};
function object(raw: string): Record<string, unknown> {
  if(typeof raw !== 'string' || raw.length > 1024*1024)deny();
  const value: unknown = JSON.parse(raw);
  if(typeof value !== 'object' || value === null || Array.isArray(value))deny();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {return typeof value === 'string' ? value : deny();}
function exact(value: Record<string,unknown>, keys: readonly string[]): void {
  if(Object.keys(value).length !== keys.length || keys.some(key=>!Object.hasOwn(value,key)))deny();
}
function fixtureCatalog(fixture: string) {
  const id = fixture === 'routing-lab-peer' ? 'routing-lab' : fixture;
  if(!Object.hasOwn(BUNDLED_FIXTURES,id) || id === 'nap-support' || id === 'approval-lab-v1' || id === 'approval-lab-v2' || id === 'approval-lab-v3' || id === 'feed-lab-v1')return deny();
  return BUNDLED_FIXTURES[id as keyof typeof BUNDLED_FIXTURES];
}
/** Trusted shell tool: prepared bytes come only from the native sealed catalog, never a guest or picker. */
export class FixturePublisher {
  private state: FixturePublisherState = Object.freeze({phase:'idle',review:null,result:''});
  private pending: Pending | null = null;
  private readonly foregroundState = new SigningForeground();
  private readonly listeners = new Set<()=>void>();
  private readonly native: FixtureReleasePort;
  private readonly effects: FixturePublisherEffects;
  constructor(native: FixtureReleasePort, effects: FixturePublisherEffects) {this.native=native;this.effects=effects;}
  getSnapshot = (): FixturePublisherState => this.state;
  subscribe = (listener: ()=>void): (()=>void) => {this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
  private update(phase: FixturePublisherState['phase'], review: FixtureReleaseReview|null, result=''): void {
    this.state=Object.freeze({phase,review,result});for(const listener of this.listeners)listener();
  }
  foreground(): void { this.foregroundState.setActive(true); }
  background(): void {
    this.foregroundState.setActive(false);
    if (!this.pending?.signingSource || signingHandoffState(this.effects, this.pending.signingSource) !== 'pending') this.cancel();
  }
  cancel(): void {
    this.pending?.abort.abort();this.pending?.bytes.fill(0);this.pending=null;
    this.native.cancelFixtureRelease();this.update('idle',null);
  }
  private active(pending: Pending): void {
    const actual=this.effects.owner();pending.owner.assertActive();actual.assertActive();
    if(!this.foregroundState.active || this.pending!==pending || pending.abort.signal.aborted || actual.user!==pending.owner.user || actual.epoch!==pending.owner.epoch)deny();
  }
  private authority(pending: Pending, stage: 'upload'|'manifest'): EffectAuthority {
    return Object.freeze({nativeSource: Object.freeze({kind: stage === 'upload' ? 'fixture-upload' : 'fixture-manifest', token: pending.token}), signal:pending.abort.signal,awaitForeground:()=>{
      if(!this.foregroundState.active && signingHandoffState(this.effects,pending.signingSource ?? undefined)!=='resumed')deny();
      return this.foregroundState.wait(pending.abort.signal);
    },assertActive:()=>{
      this.active(pending);
      if(!(stage==='upload'?this.native.isFixtureUploadApproved(pending.token):this.native.isFixtureManifestApproved(pending.token)))deny();
    }});
  }
  private fail(pending: Pending|null, message: string): void {
    if(pending && this.pending!==pending)return;
    const review=this.state.review;
    this.pending?.abort.abort();this.pending?.bytes.fill(0);this.pending=null;
    this.native.cancelFixtureRelease();this.update('failed',review,message);
  }
  async prepare(fixture: string, serverInput: string, relayInputs: readonly string[]): Promise<void> {
    this.cancel();this.update('preparing',null);
    let pending: Pending|null=null;
    try {
      const owner=this.effects.owner();owner.assertActive();
      const expected=fixtureCatalog(fixture), server=normalizeUploadServer(serverInput);
      const relays=Object.freeze(relayInputs.map(normalizeRelayUrl));
      if(relays.length<1 || relays.length>8 || new Set(relays).size!==relays.length)deny();
      const raw=object(this.native.prepareFixtureUpload(fixture,server));
      exact(raw,['token','fixture','identity','server','sha256','size','html','tags']);
      if(raw.fixture!==fixture || raw.identity!==owner.user || raw.server!==server || raw.sha256!==expected.sha256 ||
        !Number.isSafeInteger(raw.size) || typeof raw.size!=='number' || raw.size<1 || raw.size>2*1024*1024)deny();
      const token=string(raw.token);if(!/^[0-9a-f-]{36}$/.test(token))deny();
      const bytes=new TextEncoder().encode(string(raw.html));if(bytes.length!==raw.size)deny();
      const review=Object.freeze({fixture,identity:owner.user,server,sha256:expected.sha256,size:bytes.length,mimeType:'text/html' as const,relays});
      pending={token,bytes,review,owner,abort:new AbortController(),signingSource:null,manifest:null};this.pending=pending;
      if(await this.effects.hash(new Uint8Array(bytes))!==expected.sha256)deny();this.active(pending);
      this.update('upload-review',review);
    } catch {this.fail(pending,'The sealed fixture could not be prepared. Nothing was signed or sent.');}
  }
  async approveUpload(review: FixtureReleaseReview): Promise<void> {
    const pending=this.pending;if(!pending || this.state.phase!=='upload-review' || this.state.review!==review)return;
    this.update('uploading',review);
    try {
      this.active(pending);if(!this.native.approveFixtureUpload(pending.token))deny();
      const authority=this.authority(pending,'upload');authority.assertActive();
      const snapshot=await captureUploadSnapshot(pending.bytes,review.identity,review.server,review.mimeType,this.effects.now()-1,this.effects.hash);
      authority.assertActive();if(snapshot.sha256!==review.sha256 || snapshot.size!==review.size)deny();
      pending.signingSource=authority.nativeSource!;
      const signed=await this.effects.signUpload(snapshot,authority);await authority.awaitForeground?.();
      pending.signingSource=null;authority.assertActive();
      const credential=captureUploadAuthorization(snapshot,signed,this.effects.now());
      const result=object(await this.native.putFixtureUpload(pending.token,credential.token));this.active(pending);
      if(result.ok!==true || result.retrievedSha256!==review.sha256 || result.retrievedSize!==review.size) {
        this.fail(pending,string(result.error ?? 'The upload receipt or stored bytes could not be verified.'));return;
      }
      const captured=object(this.native.prepareFixtureManifest(pending.token,review.relays));
      exact(captured,['identity','relays','event']);
      if(captured.identity!==review.identity || JSON.stringify(captured.relays)!==JSON.stringify(review.relays))deny();
      const event=captureEventSnapshot(captured.event,review.identity,review.relays);
      const catalog=fixtureCatalog(review.fixture);
      const tags: string[][]=[['d',review.fixture],['path','/index.html',review.sha256],['x',catalog.aggregateHash,'aggregate'],
        ...catalog.domains.filter(domain=>domain!=='theme').slice().sort().map(domain=>['requires',domain])];
      if(review.fixture==='routing-lab-peer')tags.push(['archetype','note','napplet:note/open']);
      tags.push(['server',review.server]);
      if(event.event.kind!==35129 || event.event.content!=='' || JSON.stringify(event.event.tags)!==JSON.stringify(tags))deny();
      pending.manifest=event;
      pending.review=Object.freeze({...review,event});this.update('manifest-review',pending.review);
    } catch {this.fail(pending,'Upload interrupted or unverified. Check the exact server and hash before a fresh approved retry.');}
  }
  async approveManifest(review: FixtureReleaseReview): Promise<void> {
    const pending=this.pending, snapshot=pending?.manifest;
    if(!pending || !snapshot || this.state.phase!=='manifest-review' || this.state.review!==review)return;
    this.update('publishing',review);
    try {
      this.active(pending);const raw=this.native.approveFixtureManifest(pending.token);if(raw===null)return deny();
      const claimed=object(raw), exactSnapshot=captureEventSnapshot(claimed.event,review.identity,review.relays);
      if(claimed.identity!==review.identity || JSON.stringify(claimed.relays)!==JSON.stringify(review.relays) || exactSnapshot.hash!==snapshot.hash)deny();
      const authority=this.authority(pending,'manifest');authority.assertActive();
      pending.signingSource=authority.nativeSource!;
      const signed=await this.effects.signManifest(snapshot,authority);await authority.awaitForeground?.();
      pending.signingSource=null;authority.assertActive();
      const event=validateSignedEvent(snapshot,signed);
      const receipts=await this.effects.publish(event,review.relays,authority);authority.assertActive();
      const approvedRelays=new Set(snapshot.destinations);
      if(!receipts.some(receipt=>approvedRelays.has(receipt.relay) && receipt.eventId===event.id && receipt.status==='accepted'))deny();
      const stored: string[]=[];
      for(const relay of review.relays) {
        try {
          const candidates=await this.effects.source.query({kind:35129,pubkey:review.identity,identifier:review.fixture},[relay],event.id,pending.abort.signal);
          authority.assertActive();
          for(const candidate of candidates) {
            try {if(validateSignedEvent(snapshot,candidate).id===event.id){stored.push(relay);break;}} catch { /* Preserve failed exact-event retrieval. */ }
          }
        } catch {authority.assertActive();} // An unavailable relay does not erase another relay's verified storage.
      }
      if(stored.length===0)deny();
      const result=JSON.stringify({naddr:naddrEncode({kind:35129,pubkey:event.pubkey,identifier:review.fixture,relays:stored}),eventId:event.id,publisher:event.pubkey,fixture:review.fixture,sha256:review.sha256,receipts,independentlyStored:stored,event},null,2);
      pending.bytes.fill(0);pending.abort.abort();this.pending=null;this.native.cancelFixtureRelease();this.update('complete',review,result);
    } catch {this.fail(pending,'The manifest was not fully verified. A dispatched event may exist; check its reviewed ID before retrying.');}
  }
}
