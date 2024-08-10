import { NDKEvent, type NDKTag } from '@nostr-dev-kit/ndk';
import { MapOfVotes, MeritRequest, Votes } from './merits';
import { getAuthorizedZapper } from '@/helpers';
import validate from 'bitcoin-address-validation';
import { BitcoinTipTag, bitcoinTip, txs } from '@/stores/bitcoin';

export class Rocket {
	Event: NDKEvent;
	UpsertBitcoinAssociation(association: BitcoinAssociation): NDKEvent | undefined {
		let event: NDKEvent | undefined = undefined;
		if (association.Validate()) {
			let existing = this.BitcoinAssociations().get(association.Address!);
			if ((existing && existing.Pubkey != association.Pubkey) || !existing) {
				this.PrepareForUpdate();
				event = new NDKEvent(this.Event.ndk, this.Event.rawEvent());
				event.created_at = Math.floor(new Date().getTime() / 1000);
				event.tags.push(['address', `${association.Pubkey}:${association.Address}`]);
				event.tags.push(['proof_full', JSON.stringify(association.Event.rawEvent())]);
				updateIgnitionAndParentTag(event);
				updateBitcoinTip(event);
			}
		}
		return event;
	}
	BitcoinAssociations(): Map<string, BitcoinAssociation> {
		let a = new Map<string, BitcoinAssociation>();
		for (let t of this.Event.getMatchingTags('address')) {
			if (t.length == 2) {
				let split = t[1].split(':');
				if (split.length == 2) {
					let ba = new BitcoinAssociation();
					ba.Address = split[1];
					ba.Pubkey = split[0];
					if (ba.Validate()) {
						a.set(ba.Address, ba);
					}
				}
			}
		}
		return a;
	}
	UpsertMeritTransfer(): NDKEvent | undefined {
		let event: NDKEvent | undefined = undefined;
		return event;
	}

	URL(): string {
		let ignitionID = undefined;
		if (
			this.Event.getMatchingTags('ignition') &&
			this.Event.getMatchingTags('ignition')[0] &&
			this.Event.getMatchingTags('ignition')[0][1]
		) {
			ignitionID = this.Event.getMatchingTags('ignition')[0][1];
		}
		if (!ignitionID) {
			ignitionID = this.Event.id;
		}
		let d = this.Event.getMatchingTags('d')[0][1];
		let p = this.Event.pubkey;
		return `${ignitionID}?d=${d}&p=${p}`;
	}
	Name(): string {
		return this.Event.dTag!;
	}
	Mission(): string {
		if (
			this.Event.getMatchingTags('mission') &&
			this.Event.getMatchingTags('mission')[0] &&
			this.Event.getMatchingTags('mission')[0][1]
		) {
			return this.Event.getMatchingTags('mission')[0][1];
		}
		return '';
	}
	Products(): Map<string, RocketProduct> {
		let _products = new Map<string, RocketProduct>();
		for (let p of this.Event.getMatchingTags('product')) {
			let rp = new RocketProduct(p);
			_products.set(rp.ID, rp);
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
			updateBitcoinTip(event);
		}
		return event;
	}
	PendingAMRAuctions(): AMRAuction[] {
		let auctions: AMRAuction[] = [];
		for (let t of this.Event.getMatchingTags('amr_auction')) {
			if (t.length == 2) {
				let items = t[1].split(':');
				if (items.length == 6) {
					let a = new AMRAuction(this.Event);
					a.RxAddress = items[0];
					a.StartPrice = parseInt(items[2], 10);
					a.EndPrice = parseInt(items[3], 10);
					a.Merits = parseInt(items[4], 10);

					let ids = items[5].match(/.{1,64}/g);
					if (ids) {
						for (let id of ids) {
							a.AMRIDs.push(id);
						}
					}
					let amrs = this.ApprovedMeritRequests();
					let failed = false;
					for (let id of a.AMRIDs) {
						let amr = amrs.get(id);
						if (!amr) {
							failed = true;
						} else {
							if (!a.Owner) {
								a.Owner = amr.Pubkey;
							} else if (a.Owner != amr.Pubkey) {
								failed = true;
							}
						}
					}
					if (!failed) {
						auctions.push(a);
					} else {
						throw new Error('this should not happen, bug!');
					}
				}
			}
		}
		return auctions;
	}
	CanThisAMRBeSold(amr: string): boolean {
		let valid = true;
		let existing = this.ApprovedMeritRequests().get(amr);
		if (!existing) {
			valid = false;
		}
		if (existing && existing.LeadTime > 0) {
			valid = false;
		}
		let pending = this.PendingAMRAuctions();
		for (let p of pending) {
			if (p.AMRIDs.includes(amr)) {
				valid = false;
			}
		}
		return valid;
	}
	UpsertAMRAuction(request: AMRAuction): NDKEvent | undefined {
		//todo: validate that all items in the request exist and the total amount is correct, from same pubkey
		let event: NDKEvent | undefined = undefined;
		let invalid = false;
		if (request.ValidateAgainstRocket(this)) {
			this.PrepareForUpdate();
			event = new NDKEvent(this.Event.ndk, this.Event.rawEvent());
			event.created_at = Math.floor(new Date().getTime() / 1000);
			let totalMerits = 0;
			let requestIDs: string = '';
			for (let id of request.AMRIDs) {
				let amr = this.ApprovedMeritRequests().get(id);
				if (!amr) {
					invalid = true;
				} else {
					if (amr.LeadTime > 0 || amr.Pubkey != request.Owner) {
						invalid = true;
					} else {
						totalMerits += amr.Merits;
						requestIDs += id;
					}
				}
			}
			if (totalMerits != request.Merits) {
				invalid = true;
			}
			event.tags.push([
				'amr_auction',
				`${request.RxAddress}:${0}:${request.StartPrice}:${request.EndPrice}:${request.Merits}:${requestIDs}`
			]); //<merit request ID:start price:end price:start height:rx address>
			event.tags.push(['proof_full', JSON.stringify(request.Event!.rawEvent())]);
			updateIgnitionAndParentTag(event);
			updateBitcoinTip(event);
		}
		if (invalid) {
			event = undefined;
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
		updateBitcoinTip(event);
		return event;
	}
	UpdateMission(mission: string): NDKEvent {
		this.PrepareForUpdate();
		let event = new NDKEvent(this.Event.ndk, this.Event.rawEvent());
		event.created_at = Math.floor(new Date().getTime() / 1000);
		event.removeTag('mission');
		event.tags.push(['mission', mission]);
		updateIgnitionAndParentTag(event);
		updateBitcoinTip(event);
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

function updateBitcoinTip(event: NDKEvent) {
	let existingBitcoinTip = event.getMatchingTags('bitcoin');
	let existing = [];
	for (let t of event.tags) {
		existing.push(t);
	}
	event.tags = [];
	for (let t of existing) {
		if (t[0] !== 'bitcoin') {
			event.tags.push(t);
		}
	}
	if (existingBitcoinTip.length > 1) {
		throw new Error('too many bitcoin tip tags!');
	} else {
		event.tags.push(BitcoinTipTag());
	}
}

export class RocketAMR {
	//todo: also add a query for sats tags to find payments for this AMR
	ID: string;
	Pubkey: string;
	LeadTime: number;
	LeadTimeUpdate: number;
	Merits: number;
	Extra: { eventAMR: AMRAuction };
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
		if (product && this.Amount / 1000 >= product.Price) {
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

type AMRAuctionStatus =
	| 'PENDING'
	| 'OPEN'
	| 'TX DETECTED'
	| 'SOLD & PENDING RATIFICATION'
	| 'CHECKING MEMPOOL';

export class AMRAuction {
	AMRIDs: string[];
	Owner: string | undefined;
	StartPrice: number;
	EndPrice: number;
	RxAddress: string;
	RocketD: string;
	RocketP: string;
	Merits: number;
	Event: NDKEvent;
	Extra: { rocket: Rocket };
	Status(rocket: Rocket, bitcoinTip: number, transactions?: txs): AMRAuctionStatus {
		let status: AMRAuctionStatus = 'PENDING';
		if (transactions && transactions.Address != this.RxAddress) {
			throw new Error('invalid address');
		}
		if (transactions) {
			status = 'CHECKING MEMPOOL';
			for (let [t, txo] of transactions.From()) {
				//todo: implement pricing based on block height
				if (txo.Amount == this.EndPrice && txo.To == this.RxAddress) {
					if (txo.Height > 0 && txo.Height < bitcoinTip) {
						status = 'SOLD & PENDING RATIFICATION';
					} else {
						status = 'TX DETECTED';
					}
				}
			}
			let found = false;
			for (let pending of rocket.PendingAMRAuctions()) {
				this.AMRIDs.sort();
				pending.AMRIDs.sort();
				if (
					pending.Owner == this.Owner &&
					pending.Merits == this.Merits &&
					pending.RxAddress == this.RxAddress &&
					pending.AMRIDs[0] == this.AMRIDs[0] //todo: check whole array
				) {
					found = true;
					if (status == 'CHECKING MEMPOOL') {
						if (Math.floor(new Date().getTime() / 1000) < transactions.LastUpdate + 60000) {
							status = 'OPEN';
						}
					}
				}
			}
		}
		return status;
	}
	GenerateEvent(): NDKEvent {
		let e = new NDKEvent();
		e.kind = 1412;
		e.created_at = Math.floor(new Date().getTime() / 1000);
		for (let id of this.AMRIDs) {
			e.tags.push(['request', id]);
		}
		e.tags.push(['a', `31108:${this.RocketP}:${this.RocketD}`]);
		//todo: allow user to set start and end auction price

		e.tags.push(['price', this.StartPrice + ':' + this.EndPrice]);
		e.tags.push(['merits', this.Merits.toString()]);
		e.tags.push(['onchain', this.RxAddress]);
		return e;
	}
	Push(amr: RocketAMR) {
		if (this.Owner && amr.Pubkey != this.Owner) {
			throw new Error('invalid pubkey');
		}
		this.Owner = amr.Pubkey;
		this.AMRIDs.push(amr.ID);
		this.StartPrice += amr.Merits;
		this.EndPrice += amr.Merits;
		this.Merits += amr.Merits;
	}
	Pop(amr: RocketAMR) {
		if (this.AMRIDs.includes(amr.ID) && amr.Pubkey == this.Owner) {
			let n: string[] = [];
			for (let id of this.AMRIDs) {
				if (id != amr.ID) {
					n.push(id);
				}
			}
			this.AMRIDs = n;
			//todo: allow user to set start/end price
			this.StartPrice -= amr.Merits;
			this.EndPrice -= amr.Merits;
			this.Merits -= amr.Merits;
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
			for (let pending of rocket.PendingAMRAuctions()) {
				if (pending.AMRIDs.includes(id)) {
					valid = false;
				}
			}
		}
		return valid;
	}
	constructor(rocket?: NDKEvent, event?: NDKEvent, address?: string) {
		this.AMRIDs = [];
		this.Merits = 0;
		this.EndPrice = 0;
		this.StartPrice = 0;
		if (rocket && !event) {
			this.RxAddress = address ? address : '';
			this.RocketD = rocket.dTag!;
			this.RocketP = rocket.author.pubkey;
		}
		if (event && !rocket) {
			this.Event = event;
			for (let id of event.getMatchingTags('request')) {
				if (id && id.length == 2 && id[1].length == 64) {
					this.AMRIDs.push(id[1]);
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
			let merits = event.tagValue('merits');
			if (merits) {
				let int = parseInt(merits, 10);
				this.Merits = int;
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

export class BitcoinAssociation {
	Pubkey: string;
	Address: string | undefined;
	Event: NDKEvent;
	Balance: number;
	Validate(): boolean {
		console.log(819, this);
		let valid = true;
		if (this.Pubkey.length != 64) {
			valid = false;
		}
		if ((this.Address && !validate(this.Address)) || !this.Address) {
			valid = false;
		}
		return valid;
	}

	constructor(event?: NDKEvent) {
		this.Balance = 0;
		if (event) {
			this.Pubkey = event.pubkey;
			this.Address = event.tagValue('onchain');
			this.Event = event;
		}
	}
}

export class Product {
	Event: NDKEvent;
	Group(): string {
		let s = this.Name();
		//let regex = /\[\w+\]/i;
		//if (regex.test(this.Name())) {
		let g = this.Name().substring(this.Name().indexOf('[') + 1, this.Name().lastIndexOf(']'));
		if (g.length > 0) {
			s = g;
		}
		//}
		return s;
	}
	Option(): string {
		let result = '';
		let group = this.Name().substring(this.Name().indexOf('['), this.Name().lastIndexOf(']') + 1);
		if (group.length > 0) {
			for (let s of this.Name().trim().split(group)) {
				if (s.trim().length > 0) {
					result = s.trim();
				}
			}
		}
		return result;
	}
	ID(): string {
		return this.Event.id;
	}
	Name(): string {
		return this.Event.getMatchingTags('name')[0][1];
	}
	Description(): string {
		return this.Event.getMatchingTags('description')[0][1];
	}
	CoverImage(): string {
		return this.Event.getMatchingTags('cover')[0][1];
	}
	Validate(): boolean {
		let test = 0;
		if (
			this.Event.getMatchingTags('name') &&
			this.Event.getMatchingTags('name')[0] &&
			this.Event.getMatchingTags('name')[0][1]
		) {
			test++;
		}
		if (
			this.Event.getMatchingTags('description') &&
			this.Event.getMatchingTags('description')[0] &&
			this.Event.getMatchingTags('description')[0][1]
		) {
			test++;
		}
		if (
			this.Event.getMatchingTags('cover') &&
			this.Event.getMatchingTags('cover')[0] &&
			this.Event.getMatchingTags('cover')[0][1]
		) {
			test++;
		}
		return test == 3;
	}
	constructor(event: NDKEvent) {
		this.Event = event;
	}
}
