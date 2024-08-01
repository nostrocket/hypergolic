import { NDKEvent, type NDKTag } from '@nostr-dev-kit/ndk';
import { MapOfVotes, MeritRequest, Votes } from './merits';
import { getAuthorizedZapper } from '@/helpers';
import validate from 'bitcoin-address-validation';

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
		return _products;
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
	TotalMerits(): number {
		let total = 0;
		let amr = this.ApprovedMeritRequests();
		for (let [_, _amr] of amr) {
			total += _amr.Merits;
		}
		return total;
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
			event.tags.push(['proof_full', JSON.stringify(signedProof.rawEvent())]);
			updateIgnitionAndParentTag(event);
		}
		return event;
	}
	UpsertAMRAuction(request: AMRAuction): NDKEvent | undefined {
		let event: NDKEvent | undefined = undefined;
		if (request.ValidateAgainstRocket(this)) {
			this.PrepareForUpdate();
			event = new NDKEvent(this.Event.ndk, this.Event.rawEvent());
			event.created_at = Math.floor(new Date().getTime() / 1000);

			event.tags.push(['proof_full', JSON.stringify(request.Event!.rawEvent())]);
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
	Extra: {};
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

export async function ValidateZapPublisher(rocket: NDKEvent, zap: NDKEvent): Promise<boolean> {
	return new Promise((resolve, reject) => {
		getAuthorizedZapper(rocket)
			.then((pubkey) => {
				if (pubkey == zap.pubkey) {
					resolve(true);
				} else {
					reject();
				}
			})
			.catch(reject);
		// let z = new NDKZap({ ndk: rocket.ndk!, zappedEvent: rocket, zappedUser: rocket.author });
		// z.getZapEndpoint().then(x=>{
		// 	console.log(x)
		// 	resolve(true)
		// }).catch(()=>{reject(false)})
	});
}

export class AMRAuction {
	AMRIDs: string[];
	Owner: string|undefined;
	StartPrice: number;
	EndPrice: number;
	RxAddress: string;
	RocketD: string;
	RocketP: string;
	Merits: number;
	Event: NDKEvent;
	GenerateEvent(): NDKEvent {
		let e = new NDKEvent();
		e.kind = 1412;
		e.created_at = Math.floor(new Date().getTime() / 1000);
		for (let id of this.AMRIDs) {
			e.tags.push(["request", id])
		}
		e.tags.push(['a', `31108:${this.RocketP}:${this.RocketD}`]);
		//todo: allow user to set start and end auction price
		
		e.tags.push(['price', this.StartPrice + ":" + this.EndPrice]);
		e.tags.push(["onchain", this.RxAddress])
		return e
	}
	Push(amr: RocketAMR) {
		if (this.Owner && amr.Pubkey != this.Owner) {
			throw new Error("invalid pubkey")
		}
		this.Owner = amr.Pubkey
		this.AMRIDs.push(amr.ID);
		this.StartPrice += amr.Merits;
		this.EndPrice += amr.Merits;
		this.Merits += amr.Merits;
	}
	Pop(amr: RocketAMR) {
		if (this.AMRIDs.includes(amr.ID) && amr.Pubkey == this.Owner) {
			let n:string[] = []
			for (let id of this.AMRIDs) {
				if (id != amr.ID) {
					n.push(id)
				}
			}
			this.AMRIDs = n;
			//todo: allow user to set start/end price
			this.StartPrice -= amr.Merits
			this.EndPrice -= amr.Merits
			this.Merits -= amr.Merits
		}
	}
	Validate(): boolean {
		let valid = true;
		if (
			this.Owner?.length != 64 ||
			!this.StartPrice ||
			!this.EndPrice ||
			!validate(this.RxAddress) ||
			this.RocketP.length != 64
		) {
			valid = false;
		}
		for (let id of this.AMRIDs) {
			if (id.length != 64) {
				valid = false;
			}
		}
		return valid;
	}
	ValidateAgainstRocket(rocket: Rocket): boolean {
		let valid = true;
		for (let id of this.AMRIDs) {
			let rocketAMR = rocket.ApprovedMeritRequests().get(id);
			if (!rocketAMR || (rocketAMR && rocketAMR.Pubkey != this.Owner) || rocketAMR.LeadTime > 0) {
				valid = false;
			}
		}

		//todo: check if this AMR is already listed for sale
		return valid;
	}
	constructor(rocket?: NDKEvent, event?: NDKEvent, address?: string) {
		this.AMRIDs = [];
		this.Merits = 0
		this.EndPrice = 0
		this.StartPrice = 0
		if (rocket && !event) {
			this.RxAddress = address?address:""
			this.RocketD = rocket.dTag!;
			this.RocketP = rocket.author.pubkey;
		}
		if (event && !rocket) {
			this.Event = event
			for (let id of event.getMatchingTags("request")) {
				if (id && id.length == 2 && id[1].length == 64) {
					this.AMRIDs.push(id[1])
				}
			}
			this.Owner = event.author.pubkey;
			let price = event.tagValue('price');
			if (price) {
				let _start = price.split(':')[0];
				let _end = price.split(':')[1];
				let start = parseInt(_start, 10);
				let end = parseInt(_end, 10);
				this.StartPrice = start;
				this.EndPrice = end;
			}
			let address = event.tagValue('onchain');
			if (address) {
				if (validate(address)) {
					this.RxAddress = address;
				}
			}
			let _rocket = event.tagValue('a');
			if (_rocket) {
				if (_rocket.split(':').length == 3) {
					this.RocketP = _rocket.split(':')[1];
					this.RocketD = _rocket.split(':')[2];
				}
			}
		}
	}
}
