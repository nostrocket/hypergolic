import { requireNativeModule } from 'expo';
import { createContext, useEffect } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { isWorkspaceFullscreen } from './workspace-activity';
import type { Workspace } from './workspace';

export const WorkspaceFullscreenContext = createContext(false);

const androidChrome = Platform.OS === 'android'
  ? requireNativeModule<{setWorkspaceFullscreen(fullscreen: boolean): Promise<void>}>('HypergolicNappletHost')
  : null;

export function useWorkspaceFullscreen(workspace: Workspace): boolean {
  const fullscreen = isWorkspaceFullscreen(workspace, useWindowDimensions());
  useEffect(() => {
    if (!fullscreen || !androidChrome) return;
    const chrome = androidChrome;
    const setFullscreen = (enabled: boolean) => { void chrome.setWorkspaceFullscreen(enabled).catch(() => undefined); };
    setFullscreen(true);
    return () => setFullscreen(false);
  }, [fullscreen]);
  return fullscreen;
}
