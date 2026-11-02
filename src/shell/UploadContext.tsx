import { createContext, useContext } from 'react';
import type { UploadService } from '../uploads/upload-service.ts';
export const UploadContext = createContext<UploadService | null>(null);
export const UploadProvider = UploadContext.Provider;
export function useUploadService(): UploadService | null { return useContext(UploadContext); }
