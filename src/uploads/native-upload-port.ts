import { requireNativeModule } from 'expo';
import { createNativeUploadPort, type UploadModule } from './upload-port';
export function loadNativeUploadPort() {
  return createNativeUploadPort(requireNativeModule<UploadModule>('HypergolicNappletHost'));
}
