import type { FixturePublisher } from '../fixture-release/publisher.ts';

export function updateFixturePublisherAppState(service: FixturePublisher, state: string | null | undefined): void {
  if (state === 'active') service.foreground();
  else service.background();
}
