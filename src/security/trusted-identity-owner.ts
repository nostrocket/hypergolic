import {createNativeFixturePublisher} from '../fixture-release/native-publisher';
import type {FixturePublisher} from '../fixture-release/publisher';
import {loadNativeOutboxSubscriptions} from '../outbox/native-subscription-port';
import {openOutboxRelayListCache} from '../outbox/relay-list-cache';
import {loadNativeOutboxReadService} from '../outbox/native-read-port';
import {createNotificationSettings, type NotificationSettingsService} from '../presentation/notify-settings';
import {ConfigBroker} from '../presentation/config-broker';
import {openNativeConfigStore} from '../presentation/config-store-native';
import {NotifyBroker} from '../presentation/notify-broker';
import {openNotifyPermissions, type NotifyPermissions} from '../presentation/notify-permissions';
import { createRoutingSettings, type RoutingSettingsService } from '../routing/routing-settings';
import {openRoutingCatalog, type RoutingCatalog} from '../routing/routing-catalog';
import {RoutingBroker} from '../routing/routing-broker';
import {RoutingReviewService} from '../routing/routing-review';
import {createRoutingTargets} from '../routing/routing-targets';
import {loadRoutingNativePort} from '../routing/routing-native';
import {bindRoutingOwner, type NativeRoutingOwner} from '../routing/routing-owner';
import {bindLinkOwner, type NativeLinkOwner} from '../links/link-owner';
import {openIdentityListAccess, type IdentityListAccess} from '../identity/identity-permissions';
import {loadIdentityListNativePolicy} from '../identity/identity-permissions-native';
import { openIdentityCache } from '../identity/identity-cache';
import {createProfileAvatarReader} from '../identity/profile-avatar-image';
import {bindProfileAvatarOwner, createProfileAvatarStore, type ProfileAvatarStore} from '../identity/profile-avatar';
import type {NativePublishedHttpsPort} from '../napplets/native-published-https';
import { createIdentityDataService } from '../identity/identity-service';
import { requireNativeModule } from 'expo';
import { digest, CryptoDigestAlgorithm } from 'expo-crypto';
import { UploadService } from '../uploads/upload-service';
import { loadNativeUploadPort } from '../uploads/native-upload-port';
import { openNativeUploadSettings, type NativeUploadSettings, type UploadConfigurationModule } from '../uploads/upload-settings-native';
import { loadNativeResourceHost } from '../resources/native-resource-port';
import { openNativeResourceSettings, type NativeResourceSettings } from '../resources/resource-settings-native';
import {loadNativeRelaySubscriptions} from '../network/native-relay-subscription-port';
import { ApprovalService } from './approval-service';
import { createApprovalOwner, createUploadOwner } from './approval-owner';
import { loadNativeApprovalPort } from '../runtime/native-approval-port';
import { loadNativeRelayQuery } from '../network/native-relay-query-port';
import { publishEvent } from '../network/relay-service';
import { openNativeRelaySettings, type NativeRelaySettings } from '../network/relay-settings-native';
import { Platform } from 'react-native';
import { createRuntimeOwner, type RuntimeOwner } from '../runtime/runtime-owner';
import { loadNativeCapabilityPort } from '../runtime/native-capability-port';
import { loadNativePublishedArtifactSource } from '../napplets/native-published-source-port';
import { loadNativePublishedTransferPort } from '../napplets/native-transfer-port';
import * as SQLite from 'expo-sqlite';
import { createNativeIdentityActions, type IdentitySettingsActions } from './native-identity-actions';
import type { NativeVaultModule } from './native-vault-contract';
import { VaultError } from './identity-vault-model';
import { IdentityDeviceRequired } from './identity-device-required';
import { NativeIdentityVault } from './native-identity-vault';
import { formatNpub } from './public-identity';
import { openShellDatabase } from '../storage/database';
import { IdentityTransition } from './identity-transition';
import { assertWorkspaceAvailability, initialTestWorkspace } from '../shell/fixtures';

export interface TrustedIdentityOwner {
  readonly profileAvatar?: ProfileAvatarStore;
  readonly notify?: NotifyBroker;
  readonly notificationSettings?: NotificationSettingsService;
  readonly config?: ConfigBroker;
  readonly routing?: Readonly<{broker: RoutingBroker; catalog: RoutingCatalog; reviews: RoutingReviewService; settings: RoutingSettingsService}>;
  readonly listAccess?: IdentityListAccess | null;
  readonly transition: IdentityTransition;
  readonly actions?: IdentitySettingsActions;
  readonly runtime?: RuntimeOwner;
  readonly approvals?: ApprovalService;
  readonly uploads?: UploadService;
  readonly fixturePublisher?: FixturePublisher;
  readonly uploadSettings?: NativeUploadSettings | null;
  readonly relaySettings: NativeRelaySettings | null;
  readonly resourceSettings: NativeResourceSettings | null;
  readonly formatNpub: typeof formatNpub;
}
export class WorkspaceStartupError extends Error {
  constructor() { super('Workspace could not be opened'); this.name = 'WorkspaceStartupError'; }
}
async function openOwnerWorkspace(vault: NativeIdentityVault, platform: 'android' | 'ios'): Promise<{ profileAvatar: ProfileAvatarStore; notificationSettings: NotificationSettingsService; config: ConfigBroker; notify: NotifyBroker; routing: Readonly<{broker: RoutingBroker; catalog: RoutingCatalog; reviews: RoutingReviewService; settings: RoutingSettingsService}>; listAccess: IdentityListAccess | null; transition: IdentityTransition; runtime: RuntimeOwner; approvals: ApprovalService; relaySettings: NativeRelaySettings | null; resourceSettings: NativeResourceSettings | null; uploadSettings: NativeUploadSettings | null; uploads: UploadService; fixturePublisher: FixturePublisher }> {
  const database = await openShellDatabase(SQLite, platform).catch(() => { throw new WorkspaceStartupError(); });
  let relaySettings: NativeRelaySettings | null = null;
  let resourceSettings: NativeResourceSettings | null = null;
  let uploadSettings: NativeUploadSettings | null = null;
  let listAccess: IdentityListAccess | null = null;
  let releaseAvatar: (() => void) | null = null;
  let releaseLinks: (() => void) | null = null;
  let releaseRouting: (() => void) | null = null;
  let routingCatalog: RoutingCatalog | null = null;
  let routingBroker: RoutingBroker | null = null;
  let notifyPermissions: NotifyPermissions | null = null;
  let notifyBroker: NotifyBroker | null = null;
  let configBroker: ConfigBroker | null = null;
  let identityCache: Awaited<ReturnType<typeof openIdentityCache>> | null = null;
  let outboxCache: Awaited<ReturnType<typeof openOutboxRelayListCache>> | null = null;
  try {
    try { relaySettings = await openNativeRelaySettings(SQLite, platform); } catch { relaySettings = null; }
    try { resourceSettings = await openNativeResourceSettings(SQLite); } catch { resourceSettings = null; }
    try { uploadSettings = await openNativeUploadSettings(SQLite, requireNativeModule<UploadConfigurationModule>('HypergolicNappletHost')); } catch { uploadSettings = null; }
    routingCatalog = await openRoutingCatalog(SQLite, platform);
    notifyPermissions = await openNotifyPermissions(SQLite, platform);
    identityCache = await openIdentityCache(SQLite, platform);
    outboxCache = await openOutboxRelayListCache(SQLite, platform);
    const outbox = loadNativeOutboxReadService(outboxCache, () => relaySettings?.getSettings() ?? {networkRelays: [], lookupRelays: []});
    const queries = loadNativeRelayQuery(() => relaySettings?.getSettings().networkRelays ?? []);
    const transition = await IdentityTransition.open({ vault, database, seed: initialTestWorkspace, assertAvailable: assertWorkspaceAvailability });
    releaseRouting = bindRoutingOwner(transition, requireNativeModule<NativeRoutingOwner>('HypergolicNappletHost'));
    releaseLinks = bindLinkOwner(transition, requireNativeModule<NativeLinkOwner>('HypergolicNappletHost'));
    try {listAccess = await openIdentityListAccess(SQLite, platform, loadIdentityListNativePolicy(), () => {const state = transition.getSnapshot(); return state.phase === 'ready' ? state.session.vault.selectedPubkey : '';});} catch {listAccess = null;}
    let runtime: RuntimeOwner | null = null;
    const approvals = new ApprovalService(loadNativeApprovalPort(), createApprovalOwner(transition, (origin,domain) => {
      if (!runtime) throw new Error('APPROVAL_DENIED');
      runtime.assertPublishedApproval(origin,domain);
    }), {
      handoffState: source => vault.signingHandoffState(source),
      sign: (snapshot, execution) => vault.signApproved(snapshot, execution),
      publishEvent,
    },outbox.publication);
    const uploads = new UploadService(loadNativeUploadPort(), createUploadOwner(transition, origin => {
      if (!runtime) throw new Error('APPROVAL_DENIED');
      runtime.assertPublishedUpload(origin);
    }), {
      handoffState: source => vault.signingHandoffState(source),
      currentIdentity: () => transition.getSnapshot().phase === 'ready' ? transition.getSnapshot().session.vault.selectedPubkey : null,
      sha256: async bytes => Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)), byte => byte.toString(16).padStart(2, '0')).join(''),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      sign: (snapshot, execution) => vault.signApprovedUpload(snapshot, execution),
    });
    const capability = loadNativeCapabilityPort(), routingNative = loadRoutingNativePort();
    const reviews = new RoutingReviewService();
    notifyBroker = new NotifyBroker(capability, routingNative, notifyPermissions);
    configBroker = new ConfigBroker(capability, routingNative, await openNativeConfigStore());
    routingBroker = new RoutingBroker(capability, routingNative, routingCatalog, reviews, createRoutingTargets(transition, () => runtime, reviews, routingNative));
    const routing = Object.freeze({broker: routingBroker, catalog: routingCatalog, reviews, settings: createRoutingSettings(transition, routingNative, routingCatalog, routingBroker)});
    const identityData = createIdentityDataService(identityCache, queries, Date.now, listAccess ?? undefined);
    const profileAvatar = createProfileAvatarStore(identityData, createProfileAvatarReader(requireNativeModule<NativePublishedHttpsPort>('HypergolicNappletHost')));
    releaseAvatar = bindProfileAvatarOwner(transition, profileAvatar);
    runtime = createRuntimeOwner(database, transition, capability,
      { service: approvals, destinations: () => relaySettings?.getSettings().networkRelays ?? [] },
      { sqlite: SQLite, source: loadNativePublishedArtifactSource(), native: loadNativePublishedTransferPort(),
        lookupRelays: () => relaySettings?.getSettings().lookupRelays ?? [] },
      queries,
      loadNativeRelaySubscriptions(() => relaySettings?.getSettings().networkRelays ?? []),
      loadNativeResourceHost(() => resourceSettings?.servers() ?? [], queries), uploads, identityData, routing, notifyBroker, configBroker, outbox, loadNativeOutboxSubscriptions(outbox));
    const fixturePublisher=createNativeFixturePublisher(vault,transition);
    return { profileAvatar, fixturePublisher, notificationSettings: createNotificationSettings(transition, routingNative, notifyBroker), config: configBroker, notify: notifyBroker, routing, listAccess, transition, approvals, relaySettings, resourceSettings, uploadSettings, uploads, runtime };
  } catch {
    releaseAvatar?.(); releaseLinks?.(); releaseRouting?.(); routingBroker?.stop(); notifyBroker?.stop(); configBroker?.stop();
    try { await notifyPermissions?.close(); } catch { /* Preserve the workspace failure. */ }
    try { await routingCatalog?.close(); } catch { /* Preserve the workspace failure. */ }
    try { await listAccess?.close(); } catch { /* Preserve the workspace failure. */ }
    try { await outboxCache?.close(); } catch { /* Preserve the workspace failure. */ }
    try { await identityCache?.close(); } catch { /* Preserve the workspace failure. */ }
    try { await uploadSettings?.close(); } catch { /* Preserve the workspace failure. */ }
    try { await resourceSettings?.close(); } catch { /* Preserve the workspace failure. */ }
    try { await relaySettings?.close(); } catch { /* Preserve the workspace failure. */ }
    try { await database.close(); } catch { /* Preserve the workspace failure. */ }
    throw new WorkspaceStartupError();
  }
}

/** Dynamically imported only after the native process claim succeeds. */
export async function openTrustedIdentityOwner(): Promise<TrustedIdentityOwner> {
  const platform = Platform.OS;
  if (platform !== 'android' && platform !== 'ios') throw new VaultError('STORAGE_FAILURE');
  const native = requireNativeModule<NativeVaultModule>('HypergolicSignerCore');
  if (native.activateNativeVault() !== true) throw new VaultError('STORAGE_FAILURE');
  const available = await native.isNativeVaultAvailableAsync();
  if (available === false && platform === 'ios') throw new IdentityDeviceRequired();
  if (available !== true) throw new VaultError('STORAGE_FAILURE');
  const vault = new NativeIdentityVault(native);
  const actions = createNativeIdentityActions(vault);
  try {
    await vault.open();
    return Object.freeze({ ...await openOwnerWorkspace(vault, platform), formatNpub, actions });
  } catch (error) {
    try { actions.dispose(); } catch { /* Native owner remains consumed. */ }
    throw error;
  }
}
