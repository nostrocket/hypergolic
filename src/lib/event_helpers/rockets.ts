import { NDKEvent, type NDKTag } from '@nostr-dev-kit/ndk';

export class RocketProduct {
	ID: string;
	Price: number;
	ValidAfter: number; //unix time
	MaxPurchases: number;
	Purchases: Map<string, ProductPayment>;

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
	return getNumberFromTag("amount", zapRequest)
}

export function getNumberFromTag(tag:string, event?: NDKEvent): number {
	let amountTag = event?.getMatchingTags(tag);
	if (amountTag && amountTag[0] && amountTag[0][1]) {
		try {
			let amount = parseInt(amountTag[0][1], 10);
			return amount
		} catch {
			console.log("ERROR: could not find number in tag: ", tag, event)
		}
	}
	return 0
}
