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
	LeadTime: number;
	LastLTUpdate: number;
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
		let included = rocket.ApprovedMeritRequests();
		return Boolean(included.get(this.ID));
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
	constructor(request: NDKEvent | string) {
		if (typeof request == 'string') {
			console.log(69);
		} else {
			this.LeadTime = 0;
			this.LastLTUpdate = 0;
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
			!(this.ID.length == 64 && this.Request.length == 64 && this.VoteDirection && this.TimeStamp)
		) {
			valid = false;
		}
		return valid;
	}
	ValidateAgainstRocket(rocket: Rocket): boolean {
		let valid = true;
		if (!(rocket.VotePowerForPubkey(this.Pubkey) > 0)) {
			valid = false;
		}
		return valid;
	}
	ValidateAgainstMeritRequest(merit: MeritRequest): boolean {
		return this.Request == merit.ID;
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
		for (let t of this.Event.getMatchingTags('vote')) {
			if (t && t.length == 2 && (t[1] == 'blackball' || t[1] == 'ratify')) {
				this.VoteDirection = t[1];
			}
		}
		for (let t of this.Event.getMatchingTags('request')) {
			if (t && t.length == 2 && t[1].length == 64) {
				this.Request = t[1];
			}
		}
		if (!this.BasicValidation()) {
			throw new Error('failed to create vote');
		}
	}
}

export type VoteDirection = 'blackball' | 'ratify';

export class Votes {
	Votes: Vote[];
	Request: string;
	Results(): VoteResults {
		let ratifiers = new Map<string, Vote>();
		let blackballers = new Map<string, Vote>();
		for (let v of this.Votes) {
			if (v.VoteDirection == 'blackball') {
				blackballers.set(v.ID, v);
			}
			if (v.VoteDirection == 'ratify') {
				ratifiers.set(v.ID, v);
			}
		}
		let results: VoteResults = new VoteResults(
			new VoteTally(blackballers),
			new VoteTally(ratifiers)
		);
		return results;
	}
	constructor(votes: Vote[], request?: string) {
		this.Votes = [];
		for (let v of votes) {
			if (!request) {
				request = v.Request;
			}
			if (!this.Request) {
				this.Request = request;
			}
			if (v.Request == this.Request) {
				this.Votes.push(v);
			}
		}
	}
}

export class VoteResults {
	blackballers: VoteTally;
	ratifiers: VoteTally;
	Result(rocket: Rocket): VoteDirection | undefined {
		let result: VoteDirection | undefined = undefined;
		if (this.blackballers.TotalPercent(rocket) < 0.1 && this.ratifiers.TotalPercent(rocket) > 0.5) {
			result = 'ratify';
		}
		if (this.blackballers.TotalPercent(rocket) >= 0.1) {
			result = 'blackball';
		}
		return result;
	}
	constructor(blackballers: VoteTally, ratifiers: VoteTally) {
		this.blackballers = blackballers;
		this.ratifiers = ratifiers;
	}
}

export class VoteTally {
	Votes: Map<string, Vote>;
	Direction: VoteDirection | undefined;
	MeritRequest: string | undefined;
	BasicValidation(): boolean {
		let valid = true;
		for (let [_, v] of this.Votes) {
			if (!this.Direction) {
				this.Direction = v.VoteDirection;
			}
			if (!this.MeritRequest) {
				this.MeritRequest = v.Request;
			}
			if (v.VoteDirection != this.Direction || v.Request != this.MeritRequest) {
				valid = false;
			}
		}
		return valid;
	}
	Total(rocket: Rocket): number {
		let total = 0;
		if (this.BasicValidation()) {
			for (let [_, v] of this.Votes) {
				total += rocket.VotePowerForPubkey(v.Pubkey);
			}
		}

		return total;
	}
	TotalPercent(rocket: Rocket): number {
		let result = undefined;
		let total = this.Total(rocket);
		return total / rocket.TotalVotePower();
	}
	constructor(votes: Map<string, Vote>) {
		this.Votes = votes;
		this.Direction = undefined;
		this.MeritRequest = undefined;
		if (!this.BasicValidation()) {
			throw new Error('invalid votes detected');
		}
	}
}

export class MapOfVotes {
	Votes: Map<string, Vote>;
	constructor(votes: NDKEvent[], rocket: Rocket, merit: MeritRequest) {
		this.Votes = new Map<string, Vote>();
		for (let v of votes) {
			let vote = new Vote(v);
			if (
				vote.BasicValidation() &&
				vote.ValidateAgainstRocket(rocket) &&
				vote.ValidateAgainstMeritRequest(merit)
			) {
				this.Votes.set(vote.ID, vote); //only show the latest vote from each pubkey
			}
		}
		let pMap = new Map<string, Vote>();
		for (let [_, v] of this.Votes) {
			let existing = pMap.get(v.Pubkey);
			if (!existing || (existing && existing.TimeStamp < v.TimeStamp)) {
				//todo: check if this merit request has already been included in the rocket. If not, and if we have enough votes to approve it, update the rocket.
				pMap.set(v.Pubkey, v);
			}
		}
		this.Votes = new Map<string, Vote>();
		for (let [_, v] of pMap) {
			this.Votes.set(v.ID, v);
		}
	}
}

export class MapOfMeritResult {
	meritResult: Map</* merit id */ string, VoteDirection | undefined>;
	constructor(votes: NDKEvent[], rocket: Rocket) {
		const meritVotes = new Map<string, Votes>();
		for (let v of votes) {
			let vote = new Vote(v);
			if (vote.BasicValidation() && vote.ValidateAgainstRocket(rocket)) {
				const mVotes = meritVotes.get(vote.Request);
				if (mVotes) {
					meritVotes.set(vote.Request, pubkeyLatestVote(new Votes([...mVotes.Votes, vote])));
				} else {
					meritVotes.set(vote.Request, new Votes([vote]));
				}
			}
		}
		this.meritResult = new Map<string, VoteDirection | undefined>();
		for (let [merit, votes] of meritVotes) {
			const result = votes.Results().Result(rocket);
			this.meritResult.set(merit, result);
		}
	}
}

/**
 * only show the latest vote from each pubkey
 */
function pubkeyLatestVote(votes: Votes) {
	let pMap = new Map<string, Vote>();
	for (let v of votes.Votes) {
		let existing = pMap.get(v.Pubkey);
		if (!existing || (existing && existing.TimeStamp < v.TimeStamp)) {
			//todo: check if this merit request has already been included in the rocket. If not, and if we have enough votes to approve it, update the rocket.
			pMap.set(v.Pubkey, v);
		}
	}
	return new Votes([...pMap.values()]);
}
