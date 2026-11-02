import type { AppStateStatus } from 'react-native';
import type { FixturePublisher } from '../fixture-release/publisher.ts';

export function updateFixturePublisherAppState(service: FixturePublisher, state: AppStateStatus): void {
  if (state === 'active') service.foreground();
  else service.background();
}
