import { normalizeResourceServers, type ResourceSettings as ResourceStore } from '../resources/resource-settings';
import { BlossomSettings } from './BlossomSettings';

function parseServers(input: string) {
  return normalizeResourceServers(input.split('\n').map(line => line.trim()).filter(Boolean));
}

export function ResourceSettings({ service, onBack }: { service: ResourceStore | null; onBack(): void }) {
  return <BlossomSettings<readonly string[]> title="Blossom downloads" onBack={onBack}
    help="The shell tries these servers in order and verifies each file’s SHA-256. These device settings apply to all identities. Clearing the list disables Blossom downloads."
    unavailable="Download settings are unavailable."
    invalid="Enter up to four different public HTTPS origins, one per line. Paths and private hosts are blocked."
    field={{ label: 'Blossom download servers', id: 'resource-servers', multiline: true }}
    save={{ label: 'Save download servers', id: 'resource-servers-save' }}
    restore={{ label: 'Restore download defaults', id: 'resource-servers-defaults' }}
    statusID="resource-settings-status" saved={() => 'Download servers saved.'} parse={parseServers}
    store={service && { read: () => service.servers().join('\n'), write: value => service.replace(value), restore: () => service.restoreDefaults() }} />;
}
