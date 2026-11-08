import {createNativeClient} from '../../src/native-client';
import {captureNativeMeshContext, createMeshGuestReceiver} from '../../src/mesh-native';
import {readPublishedArtifact} from '../../src/published-artifact';
import {SUPPORTED_CAPABILITY_DOMAINS} from '../../../src/runtime/capability-protocol';

Object.defineProperty(window, 'OwnedMeshAdapter', {value: {
  createNativeClient, captureNativeMeshContext, createMeshGuestReceiver, readPublishedArtifact,
  supportedDomains: SUPPORTED_CAPABILITY_DOMAINS,
}});
