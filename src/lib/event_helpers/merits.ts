import type { NDKEvent, NDKFilter, NDKTag } from '@nostr-dev-kit/ndk';
import { Rocket, getNumberFromTag, isValidUrl } from './rockets';

export class MeritRequest {
	ID: string;
	Sats: number;
	Merits: number;
	Event: NDKEvent;
	Pubkey: string;
	TimeStamp: number;
	RocketTag: string | undefined; //31108:<pubkey>:<dtag>
	Problem(): string {
		let _problem = '';
		//todo: handle 1971 problem tracker event tags somehow
		for (let problem of this.Event.getMatchingTags('problem')) {
			if (problem && problem.length > 2) {
				_problem = problem[2];
			}
		}
		return _problem;
	}
	Solution(): URL | undefined {
		let _solution: URL | undefined = undefined;
		for (let solution of this.Event.getMatchingTags('solution')) {
			if (solution && solution.length > 2 && solution[1] == 'url') {
				if (isValidUrl(solution[2])) {
					_solution = new URL(solution[2]);
				}
			}
		}
		return _solution;
	}
	IncludedInRocketState(rocket: Rocket): boolean {
		return true;
	}
	BasicValidation(): boolean {
		//todo: make a ValidateAgainstRocket and check that pubkey is in WoT
		let valid = true;
		if (
			!(
				this.ID.length == 64 &&
				this.Merits > 0 &&
				this.Pubkey.length == 64 &&
				this.TimeStamp &&
				this.RocketTag
			)
		) {
			valid = false;
		}
		return valid;
	}
	REQFilter(kind?: number): NDKFilter {
		if (!this.BasicValidation()) {
			return {};
		}
		if (!kind) {
			kind = 31108;
		}
		return {
			'#d': [this.RocketTag?.split(':')[2]!],
			authors: [this.RocketTag?.split(':')[1]!],
			kinds: [kind as number]
		};
	}
	constructor(request: NDKEvent) {
		this.Event = request;
		this.ID = request.id;
		this.Pubkey = request.pubkey;
		if (this.Event.created_at) {
			this.TimeStamp = this.Event.created_at;
		}
		for (let tag of this.Event.getMatchingTags('a')) {
			if (tag && tag.length > 1) {
				if (tag[1].split(':') && tag[1].split(':').length == 3) {
					if ((tag[1].split(':')[0] = '31108')) {
						this.RocketTag = tag[1];
					}
				}
			}
		}

		this.Sats = getNumberFromTag('sats', request);
		this.Merits = getNumberFromTag('merits', request);
	}
}

export class Vote {
    ID: string;
    Request: string;
    VoteDirection: VoteDirection | undefined;
    Pubkey: string;
    TimeStamp: number;
	Event: NDKEvent;
	BasicValidation(): boolean {
        let valid = true;
		if (
			!(
				this.ID.length == 64 &&
                this.Request.length == 64 &&
                this.VoteDirection &&
                this.TimeStamp
			)
		) {
			valid = false;
		}
		return valid;
	}
    ValidateAgainstRocket(rocket:Rocket):boolean {
        let valid = true;
        if (!(rocket.VotePowerForPubkey(this.Pubkey) > 0)) {
            valid = false
        }
        return valid
    }
	RocketTag(): NDKTag | undefined {
		let tag: NDKTag | undefined = undefined;
		if (this.BasicValidation()) {
			for (let t of this.Event.getMatchingTags('a')) {
				if (t && t.length > 1 && t[1].split(':').length == 3 && t[1].split(':')[0] == '31108') {
					tag = t;
				}
			}
		}

		return tag;
	}
	REQFilter(kind?: number): NDKFilter {
		let filter = {};
		if (!kind) {
			kind = 31108;
		}
		if (this.BasicValidation()) {
			let t = this.RocketTag();
			if (t) {
				filter = {
					'#d': [t[1].split(':')[2]!],
					authors: [t[1].split(':')[1]!],
					kinds: [kind as number]
				};
			}
		}
		return filter;
	}
	constructor(event: NDKEvent) {
		this.Event = event;
        this.ID = event.id;
        this.Pubkey = event.pubkey;
        if (this.Event.created_at) {
			this.TimeStamp = this.Event.created_at;
		}
        for (let t of this.Event.getMatchingTags("vote")) {
            if (t && t.length == 2 && (t[1] == "blackball" || t[1] == "ratify")) {
                this.VoteDirection = t[1]
            }
        }
        for (let t of this.Event.getMatchingTags("request")) {
            if (t && t.length == 2 && t[1].length == 64) {
                this.Request = t[1]
            }
        }
	}
}

export type VoteDirection = "blackball" | "ratify"