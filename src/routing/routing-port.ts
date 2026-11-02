export type RoutingNativeState = Readonly<{ user: string; epoch: number; revision: number; available: boolean; ownerAvailable: boolean; foreground: boolean }>;
export interface RoutingNativePort {
  state(): RoutingNativeState;
  mayDeliver(generation: string, revision: number, domain: 'intent' | 'inc' | 'notify' | 'config'): boolean;
  mayReview(generation: string, revision: number): boolean;
  reviewRevision(generation: string, revision: number): number | null;
  send(generation: string, revision: number, message: Readonly<Record<string, unknown>>): boolean;
  subscribe(listener: () => void): () => void;
  newChannelId(): string;
}
