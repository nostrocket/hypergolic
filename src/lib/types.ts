import type { NDKEvent } from '@nostr-dev-kit/ndk';

export class RocketState {
	IgnitionID: string;
	Name: string;
	constructor(event?: NDKEvent) {
		if (event) {
			if (!event.dTag) {
				throw new Error('invalid rocket name, no d tag found on event');
			}
            validateRocketName(event.dTag)
			this.Name = event.dTag;
		}
	}
}

function validateRocketName(name:string) {
    if (name.length < 4) {
        throw new Error("name is too short")
    }
    if (name.length > 20) {
        throw new Error("name is too long")
    }
}