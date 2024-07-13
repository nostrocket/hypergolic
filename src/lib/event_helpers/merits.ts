import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { getNumberFromTag } from "./rockets";

export class MeritRequest {
    ID: string;
	Sats: number;
    Merits: number;
	Request: NDKEvent;
    Pubkey: string;
    TimeStamp: number;
    Problem():string {
        let _problem = ""
        //todo: handle 1971 problem tracker event tags somehow
        for (let problem of this.Request.getMatchingTags("problem")) {
            if (problem && problem.length > 2) {
                 _problem = problem[2]
            }
        }
        return _problem
    }
	IncludedInRocketState(rocket: NDKEvent): boolean {
        return true
	}
	Valid(rocket: NDKEvent): boolean {
		//todo: validate pubkey is in WoT
		let valid = true;
		return valid;
	}
	constructor(request: NDKEvent) {
		this.Request = request;
        this.ID = request.id;
        this.Pubkey = request.pubkey
        if (this.Request.created_at) {
            this.TimeStamp = this.Request.created_at
        }
        
        this.Sats = getNumberFromTag("sats", request)
        this.Merits = getNumberFromTag("merits", request)
	}
}