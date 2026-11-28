import { normalizeUploadServer } from '../uploads/upload-contract';
import type { UploadSettings as UploadStore } from '../uploads/upload-settings';
import { BlossomSettings } from './BlossomSettings';

function parseServer(input: string) {
  return input.trim() ? normalizeUploadServer(input.trim()) : null;
}

export function UploadSettings({ service, onBack }: { service: UploadStore | null; onBack(): void }) {
  return <BlossomSettings title="Blossom uploads" onBack={onBack}
    help="Each upload needs your approval and names this server. Clearing the field disables uploads. These device settings apply to all identities. Your chosen server may charge for some file types or sizes."
    unavailable="Upload settings are unavailable."
    invalid="Could not save. Enter one public HTTPS origin, without a path."
    field={{ label: 'Blossom upload server', id: 'upload-server' }}
    save={{ label: 'Save upload server', id: 'upload-server-save' }}
    restore={{ label: 'Restore upload default', id: 'upload-server-default' }}
    statusID="upload-settings-status" saved={value => value ? 'Upload server saved.' : 'Uploads disabled.'} parse={parseServer}
    store={service && { read: () => service.server() ?? '', write: value => service.replace(value), restore: () => service.restoreDefault() }} />;
}
