import validate from 'bitcoin-address-validation';
import { get, writable } from 'svelte/store';

type BitcoinTip = {
	height: number;
	hash: string;
};

let _b: BitcoinTip = { hash: '', height: 0 };
export const bitcoinTip = writable(_b);

export function BitcoinTipTag(): string[] {
	let tip = get(bitcoinTip);
	let bths: string[] = ['bitcoin', ''];
	if (tip.hash && tip.height) {
		bths = ['bitcoin', tip.height.toString() + ':' + tip.hash];
	}
	return bths;
}

export async function getBitcoinTip() {
	try {
	const response = await fetch('https://blockstream.info/api/blocks/tip');
	const _json = await response.json();
	if (_json[0]) {
		let r: BitcoinTip = {
			height: _json[0].height,
			hash: _json[0].id
		};
		bitcoinTip.set(r);
		return r;
	}} catch {
		return null;
	}
	return null;
}

export async function getBalance(address: string): Promise<number> {
	return new Promise((resolve, reject) => {
		if (!validate(address)) {
			reject('invalid address');
		} else {
			try {
				fetch(`https://blockstream.info/api/address/${address}`)
					.then((response) => {
						if (!response.ok) {
							reject('invalid response from server');
						} else {
							response
								.json()
								.then((j) => {
									let spent = parseInt(j.chain_stats.spent_txo_sum, 10);
									let funded = parseInt(j.chain_stats.funded_txo_sum, 10);
									resolve(funded - spent);
								})
								.catch((x) => reject(x));
						}
					})
					.catch((x) => {
						reject(x);
					});
			} catch {
				reject('failed');
			}
		}
	});
}
