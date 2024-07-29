import { NDKEvent, type NDKTag } from '@nostr-dev-kit/ndk';
import { MapOfVotes, MeritRequest, Votes } from './merits';

export class Rocket {
	Event: NDKEvent;
	Name(): string {
		return this.Event.dTag!;
	}
	Products(): RocketProduct[] {
		let _products: RocketProduct[] = [];
		for (let p of this.Event.getMatchingTags('product')) {
			_products.push(new RocketProduct(p));
		}
		console.log(_products)
		return _products
	}
	VotePowerForPubkey(pubkey: string): number {
		let votepower = 0;
		if (this.Event.pubkey == pubkey) {
			//todo: calculate votepower for pubkey based on approved merit requests
			votepower++;
		}
		return votepower;
	}
	TotalVotePower(): number {
		//todo: calculate votepower for pubkey based on approved merit requests
		return 1;
	}
	ApprovedMeritRequests(): Map<string, RocketAMR> {
		let amr = new Map<string, RocketAMR>();
		for (let m of this.Event.getMatchingTags('merit')) {
			if (m && m.length == 2) {
				let _amr = new RocketAMR(m[1]);
				amr.set(_amr.ID, _amr);
			}
		}
		return amr;
	}
	ValidateAMRProof(amrProof: NDKEvent): boolean {
		let result = false;
		if (this.VotePowerForPubkey(amrProof.pubkey) > 0 && amrProof.verifySignature(true)) {
			let request: NDKEvent | undefined = undefined;
			let votes: NDKEvent[] = [];
			let _request = amrProof.getMatchingTags('request');
			if (_request.length == 1) {
				try {
					let __request = new NDKEvent(undefined, JSON.parse(_request[0][1]));
					if (__request.verifySignature(true)) {
						request = __request;
					}
				} catch {}
			}
			for (let v of amrProof.getMatchingTags('vote')) {
				try {
					let vEv = new NDKEvent(undefined, JSON.parse(v[1]));
					if (vEv.verifySignature(true)) votes.push(vEv);
				} catch {}
			}
			if (request && votes.length > 0) {
				let parsedRequest = new MeritRequest(request);
				let mapOfVotes = new MapOfVotes(votes, this, parsedRequest).Votes;
				let parsedVotes = new Votes(Array.from(mapOfVotes, ([_, v]) => v));
				let voteDirection = parsedVotes.Results().Result(this);
				if (
					voteDirection &&
					voteDirection == 'ratify' &&
					!parsedRequest.IncludedInRocketState(this)
				) {
					//note: if it is included in the rocket state, we might be validating this against a previous state
					result = true;
				}
			}
		}
		return result;
	}

	CreateUnsignedAMRProof(request: MeritRequest, votes: Votes): NDKEvent | undefined {
		let proof: NDKEvent | undefined = undefined;
		let hasInvalidSig = false;
		if (request && request.Event && request.Event.sig && votes.Votes.length > 0) {
			if (!request.Event.verifySignature(true)) {
				hasInvalidSig = true;
			}
			for (let v of votes.Votes) {
				if (!(v.Event.sig && v.Event.verifySignature(true))) {
					hasInvalidSig = true;
				}
			}
			let result = votes.Results().Result(this);
			if (result && result == 'ratify' && !request.IncludedInRocketState(this) && !hasInvalidSig) {
				let e = new NDKEvent();
				e.kind = 1411;
				e.tags.push(['request', JSON.stringify(request.Event.rawEvent())]);
				for (let v of votes.Votes) {
					e.tags.push(['vote', JSON.stringify(v.Event.rawEvent())]);
				}
				proof = e;
			}
		}
		return proof;
	}
	UpsertAMR(request: MeritRequest, signedProof: NDKEvent): NDKEvent | undefined {
		let event: NDKEvent | undefined = undefined;
		if (this.ValidateAMRProof(signedProof)) {
			this.PrepareForUpdate();
			event = new NDKEvent(this.Event.ndk, this.Event.rawEvent());
			event.created_at = Math.floor(new Date().getTime() / 1000);
			event.tags.push(['merit', `${request.Pubkey}:${request.ID}:0:0:${request.Merits}`]);
			event.tags.push(['proof_full', JSON.stringify(signedProof)]);
			updateIgnitionAndParentTag(event);
		}
		return event;
	}
	UpsertProduct(id: string, price: number, maxSales?: number): NDKEvent {
		this.PrepareForUpdate();
		let event = new NDKEvent(this.Event.ndk, this.Event.rawEvent());
		event.created_at = Math.floor(new Date().getTime() / 1000);
		let existingProducts = this.CurrentProducts();
		let purchases = JSON.stringify([]);
		let existingProduct = existingProducts.get(id);
		if (existingProduct) {
			purchases = existingProduct.PurchasesJSON();
		}
		event.tags.push([
			'product',
			`${id}:${price}:${event.created_at}:${maxSales}`,
			'wss://relay.nostrocket.org',
			purchases
		]);
		updateIgnitionAndParentTag(event);
		return event;
	}
	UpdateMission(mission: string): NDKEvent {
		this.PrepareForUpdate();
		let event = new NDKEvent(this.Event.ndk, this.Event.rawEvent());
		event.created_at = Math.floor(new Date().getTime() / 1000);
		event.removeTag('mission');
		event.tags.push(['mission', mission]);
		updateIgnitionAndParentTag(event);
		return event;
	}
	CurrentProducts(): Map<string, RocketProduct> {
		return getMapOfProductsFromRocket(this.Event);
	}
	RemoveDuplicateTags() {
		function iterate(event: NDKEvent): NDKEvent {
			let purged = 0;
			for (let i = 0; i < event.tags.length; i++) {
				for (let j = i + 1; j < event.tags.length; j++) {
					// quick elimination by comparing sub-array lengths
					if (event.tags[i].length !== event.tags[j].length) {
						continue;
					}
					// look for dupes
					var dupe = true;
					for (var k = 0; k < event.tags[i].length; k++) {
						if (event.tags[i][k] !== event.tags[j][k]) {
							dupe = false;
							break;
						}
					}
					// if a dupe then remove it
					if (dupe) {
						purged++;
						event.tags.splice(j, 1);
					}
				}
			}
			if (purged > 0) {
				return iterate(event);
			} else {
				return event;
			}
		}
		this.Event = iterate(this.Event);
	}
	RemoveProofs() {
		let newTags: NDKTag[] = [];
		for (let t of this.Event.tags) {
			if (!t[0].includes('proof') && t[0] != 'client') {
				newTags.push(t);
			}
		}
		this.Event.tags = newTags;
	}
	PrepareForUpdate() {
		this.RemoveDuplicateTags();
		this.RemoveProofs();
		this.Event.sig = undefined;
	}
	constructor(event: NDKEvent) {
		this.Event = event;
	}
}

function updateIgnitionAndParentTag(event: NDKEvent) {
	let existingIgnition = event.getMatchingTags('ignition');
	//let existingParent = rocket.getMatchingTags("parent")
	let existing = [];
	for (let t of event.tags) {
		existing.push(t);
	}
	event.tags = [];
	for (let t of existing) {
		if (t[0] !== 'ignition' && t[0] !== 'parent') {
			event.tags.push(t);
		}
	}
	if (existingIgnition.length > 1) {
		throw new Error('too many ignition tags!');
	}
	if (existingIgnition.length == 0) {
		event.tags.push(['ignition', event.id]);
	}
	if (existingIgnition.length == 1) {
		if (existingIgnition[0][1].length == 64) {
			event.tags.push(existingIgnition[0]);
		}
		if (existingIgnition[0][1] == 'this') {
			event.tags.push(['ignition', event.id]);
		}
	}
	event.tags.push(['parent', event.id]);
}

export class RocketAMR {
	//todo: also add a query for sats tags to find payments for this AMR
	ID: string;
	Pubkey: string;
	LeadTime: number;
	LeadTimeUpdate: number;
	Merits: number;
	SatsOwed(): number {
		return 0;
	}
	SatsPaid(): number {
		return 0;
	}
	Valid(): boolean {
		let valid = true;
		if (!(this.ID.length == 64 && this.Pubkey.length == 64 && this.Merits)) {
			valid = false;
		}
		return valid;
	}
	constructor(meritString: string) {
		let split = meritString.split(':');
		if (split.length == 5) {
			this.Pubkey = split[0];
			this.ID = split[1];
			this.LeadTime = parseInt(split[2], 10);
			this.LeadTimeUpdate = parseInt(split[3], 10);
			this.Merits = parseInt(split[4], 10);
		}
	}
}

export class RocketProduct {
	ID: string;
	Price: number;
	ValidAfter: number; //unix time
	MaxPurchases: number;
	Purchases: Map<string, ProductPayment>;
	PurchasesJSON(): string {
		let purchases = [];
		for (let [_, p] of this.Purchases) {
			purchases.push(`${p.ZapID}:${p.BuyerPubkey}:${p.WitnessedAt}`);
		}
		return JSON.stringify(purchases);
	}
	constructor(tag: NDKTag) {
		this.Purchases = new Map();
		this.ID = tag[1].split(':')[0];
		this.Price = parseInt(tag[1].split(':')[1], 10);
		this.ValidAfter = parseInt(tag[1].split(':')[2], 10);
		this.MaxPurchases = parseInt(tag[1].split(':')[3], 10);
		let purchases = JSON.parse(tag[3]);
		for (let p of purchases) {
			let payment = new ProductPayment(p);
			this.Purchases.set(payment.ZapID, payment);
		}
	}
}

//ProductPayment takes the payment string from a product tag on a rocket event
export class ProductPayment {
	ZapID: string;
	BuyerPubkey: string;
	WitnessedAt: number;
	constructor(purchase: string) {
		this.ZapID = purchase.split(':')[0];
		this.BuyerPubkey = purchase.split(':')[1];
		this.WitnessedAt = parseInt(purchase.split(':')[2], 10);
	}
}

export function getMapOfProductsFromRocket(rocket: NDKEvent): Map<string, RocketProduct> {
	let productIDs = new Map<string, RocketProduct>();
	for (let product of rocket.getMatchingTags('product')) {
		if (product.length > 1 && product[1].split(':') && product[1].split(':').length > 0) {
			productIDs.set(product[1].split(':')[0], new RocketProduct(product));
		}
	}
	return productIDs;
}

export class ZapPurchase {
	Amount: number;
	ProductID: string;
	BuyerPubkey: string;
	ZapReceipt: NDKEvent;
	ZapRequest(): NDKEvent | undefined {
		return getZapRequest(this.ZapReceipt);
	}
	IncludedInRocketState(rocket: NDKEvent): boolean {
		let thisProduct = this.ProductFromRocket(rocket);
		if (thisProduct) {
			return thisProduct.Purchases.get(this.ZapReceipt.id) ? true : false;
		} else {
			return false;
		}
	}
	ProductFromRocket(rocket: NDKEvent): RocketProduct | undefined {
		let productsInRocket = getMapOfProductsFromRocket(rocket);
		return productsInRocket.get(this.ProductID);
	}
	ValidAmount(rocket: NDKEvent): boolean {
		if (this.Amount < 1) {
			return false;
		}
		if (this.IncludedInRocketState(rocket)) {
			return true;
		}
		let product = this.ProductFromRocket(rocket);
		if (product && this.Amount >= product.Price) {
			return true;
		}
		return false;
	}
	Valid(rocket: NDKEvent): boolean {
		//todo: validate zapper pubkey is from a LSP specified in rocket
		let valid = true;
		if (!this.ValidAmount(rocket)) {
			valid = false;
		}
		if (!this.ProductID) {
			valid = false;
		}
		if (this.ProductID && this.ProductID.length != 64) {
			valid = false;
		}
		if (this.BuyerPubkey.length != 64) {
			valid = false;
		}
		return valid;
	}
	constructor(zapReceipt: NDKEvent) {
		this.ZapReceipt = zapReceipt;
		this.Amount = getZapAmount(this.ZapRequest());
		let zapRequest = this.ZapRequest();
		if (zapRequest) {
			this.BuyerPubkey = zapRequest.pubkey;
			let products = zapRequest.getMatchingTags('product');
			if (products.length == 1 && products[0] && products[0][1] && products[0][1].length == 64) {
				this.ProductID = products[0][1];
			}
		}
	}
}

function getZapRequest(zapReceipt: NDKEvent): NDKEvent | undefined {
	let zapRequestEvent: NDKEvent | undefined = undefined;
	let zapRequest = zapReceipt.getMatchingTags('description');
	if (zapRequest.length == 1) {
		let zapRequestJSON = JSON.parse(zapRequest[0][1]);
		if (zapRequestJSON) {
			zapRequestEvent = new NDKEvent(zapReceipt.ndk, zapRequestJSON);
		}
	}
	return zapRequestEvent;
}

function getZapAmount(zapRequest?: NDKEvent): number {
	return getNumberFromTag('amount', zapRequest);
}

export function getNumberFromTag(tag: string, event?: NDKEvent): number {
	let amountTag = event?.getMatchingTags(tag);
	if (amountTag && amountTag[0] && amountTag[0][1]) {
		try {
			let amount = parseInt(amountTag[0][1], 10);
			return amount;
		} catch {
			console.log('ERROR: could not find number in tag: ', tag, event);
		}
	}
	return 0;
}

export function isValidUrl(string: string): boolean {
	try {
		new URL(string);
		return true;
	} catch (err) {
		return false;
	}
}

export function RocketATagFilter(rocket: NDKEvent): string {
	return `31108:${rocket.pubkey}:${rocket.dTag}`;
}
