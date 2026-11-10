import { developerToolsEnabled } from '../config/build-info';
import { initialTestWorkspace } from './fixtures';
import { emptyWorkspace } from './workspace';

export function initialWorkspaceForBuild() {
  return developerToolsEnabled ? initialTestWorkspace() : emptyWorkspace();
}
