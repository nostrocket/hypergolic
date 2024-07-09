import { NDKEvent, type NDKTag } from "@nostr-dev-kit/ndk";
import type NDKSvelte from "@nostr-dev-kit/ndk-svelte";

export function getZapData(ndk:NDKSvelte, zap: NDKEvent, rocket:NDKEvent) {
    let productPrice = 0;
    let zapAmount = 0;
    let productID: string | undefined = undefined;
    let buyerPubkey: string | undefined = undefined;
    let zapRequest: NDKEvent | undefined = undefined;

    let desc = zap.getMatchingTags('description');
    if (desc && desc.length == 1 && rocket) {
        zapRequest = new NDKEvent(ndk, JSON.parse(desc[0][1]));
        let zapRequestETags = zapRequest.getMatchingTags('e');

        if (zapRequestETags && zapRequestETags.length > 0) {
            for (let productIDfromZapRequest of zapRequestETags) {
                if (productIDfromZapRequest.length > 1) {
                    let productsInRocket = getMapOfProductsFromRocket(rocket);
                    if (productsInRocket.size > 0) {
                        productID = productIDfromZapRequest[1];
                        if (productID.length == 64) {
                            let productDataFromRocket = productsInRocket.get(productID);
                            if (productDataFromRocket) {
                                productPrice = productDataFromRocket.Price;
                            }
                        }
                    }
                }
            }
        }
        let amount = zapRequest.getMatchingTags('amount');
        if (amount && amount.length == 1) {
            if (amount[0].length == 2) {
                zapAmount = parseInt(amount[0][1], 10);
            }
        }
        buyerPubkey = zapRequest.author.pubkey;
    }
    let success = false;
    if (zapRequest && productID && buyerPubkey && productPrice && zapAmount) {
        if (zapAmount >= productPrice && productID.length == 64 && buyerPubkey.length == 64) {
            success = true;
            return {
                productPrice: productPrice,
                zapAmount: zapAmount,
                productID: productID,
                buyerPubkey: buyerPubkey,
                zapReceipt: zap.id
            };
        }
    }
    if (!success) {
        console.log('invalid product payment zap found:', zapRequest?.rawEvent());
    }
}

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