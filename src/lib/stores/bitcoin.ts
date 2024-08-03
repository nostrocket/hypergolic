import { get, writable } from 'svelte/store';

type BitcoinTip = {
	height: number;
	hash: string;
};

let _b: BitcoinTip = { hash: '', height: 0 };
export let bitcoinTip = writable(_b);

export function BitcoinTipTag(): string[] {
	let tip = get(bitcoinTip);
	let bths: string[] = ['bitcoin', ''];
	if (tip.hash && tip.height) {
		bths = ['bitcoin', tip.height.toString() + ':' + tip.hash];
	}
	return bths;
}

export async function getBitcoinTip() {
	const response = await fetch('https://blockstream.info/api/blocks/tip');
	const _json = await response.json();
	if (_json[0]) {
		let r: BitcoinTip = {
			height: _json[0].height,
			hash: _json[0].id
		};
		bitcoinTip.set(r);
		return r;
	}
	return null;
}
