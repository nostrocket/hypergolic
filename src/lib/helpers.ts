import { NDKZap, NDKEvent, type NDKKind, type NDKTag, type NDKUser } from '@nostr-dev-kit/ndk';
import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
import { QrCode } from '$lib/qrcodegen';

export function getRocketURL(e: NDKEvent): string {
	let ignitionID = undefined;
	if (
		e.getMatchingTags('ignition') &&
		e.getMatchingTags('ignition')[0] &&
		e.getMatchingTags('ignition')[0][1]
	) {
		ignitionID = e.getMatchingTags('ignition')[0][1];
	}
	if (!ignitionID) {
		ignitionID = e.id;
	}
	let d = e.getMatchingTags('d')[0][1];
	let p = e.pubkey;
	return `${ignitionID}?d=${d}&p=${p}`;
}

export function getMission(rocketEvent: NDKEvent): string {
	if (
		rocketEvent.getMatchingTags('mission') &&
		rocketEvent.getMatchingTags('mission')[0] &&
		rocketEvent.getMatchingTags('mission')[0][1]
	) {
		return rocketEvent.getMatchingTags('mission')[0][1];
	}
	return '';
}

export function unixTimeNow() {
	return Math.floor(new Date().getTime() / 1000);
}

export function unixToRelativeTime(timestamp: number): string {
	const currentTime = Date.now();
	const secondsAgo = Math.floor((currentTime - timestamp) / 1000);

	if (secondsAgo < 60) {
		return `${secondsAgo} seconds ago`;
	} else if (secondsAgo < 3600) {
		const minutesAgo = Math.floor(secondsAgo / 60);
		return `${minutesAgo} minute${minutesAgo === 1 ? '' : 's'} ago`;
	} else if (secondsAgo < 86400) {
		const hoursAgo = Math.floor(secondsAgo / 3600);
		return `${hoursAgo} hour${hoursAgo === 1 ? '' : 's'} ago`;
	} else if (secondsAgo < 604800) {
		const daysAgo = Math.floor(secondsAgo / 86400);
		return `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`;
	} else {
		const formattedDate = new Date(timestamp).toLocaleString('en-US', {
			weekday: 'short',
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hour12: true
		});
		return formattedDate;
	}
}

export function formatReferenceTime(hours: number) {
	const totalMinutes = Math.round(hours * 60);
	const wholeHours = Math.floor(totalMinutes / 60);
	const remainingMinutes = totalMinutes % 60;

	let result = '';

	if (wholeHours > 0) {
		result += `${wholeHours} hour${wholeHours > 1 ? 's' : ''}`;
	}

	if (remainingMinutes > 0) {
		if (result.length > 0) result += ' and ';
		result += `${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}`;
	}

	return result || '0 minutes';
}

export async function getCuckPrice(): Promise<number | Error> {
	try {
		var url = 'https://api.coindesk.com/v1/bpi/currentprice.json';
		var symbol = 'USD';
		const data = await fetch(url);
		const json = await data.json();
		const cuckPrice = parseFloat(json.bpi[symbol].rate.replace(/,/g, ''));
		return cuckPrice;
	} catch (e) {
		return e as Error;
	}
}

export async function parseProblem(problem: string) {
	if (!isGitHubUrl(problem)) {
		return;
	}

	const apiURL = convertToGitHubApiUrl(problem);
	if (!apiURL) {
		return;
	}

	const response = await fetch(apiURL);
	if (!response.ok) {
		return;
	}

	const { title } = await response.json();
	return title;
}

export function isGitHubUrl(str: string): boolean {
	let url;
	try {
		url = new URL(str);
	} catch {
		return false;
	}
	const pathParts = url.pathname.split('/').filter(Boolean);

	if (url.hostname !== 'github.com') {
		return false;
	}
	if (pathParts.length !== 4) {
		return false;
	}
	if (!['issues', 'pull'].includes(pathParts[2])) {
		return false;
	}
	if (!/^[1-9]\d*$/.test(pathParts[3])) {
		return false;
	}
	return true;
}

function convertToGitHubApiUrl(issueUrl: string): URL | null {
	const url = new URL(issueUrl);
	const [owner, repo, , issueNumber] = url.pathname.split('/').filter(Boolean);
	try {
		// Whether it's `issues` or `pull`, the API uses `issues`
		return new URL(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`);
	} catch (error) {
		console.error('URL conversion error:', error);
		return null;
	}
}

export async function getAuthorizedZapper(rocket: NDKEvent): Promise<string> {
	return new Promise((resolve, reject) => {
		let z = new NDKZap({ ndk: rocket.ndk!, zappedEvent: rocket, zappedUser: rocket.author });
		z.getZapEndpoint()
			.then((url) => {
				if (url) {
					url = url.trim().replace('/callback', '');
					fetch(url).then((result) => {
						result
							.json()
							.then((j) => {
								resolve(j.nostrPubkey);
							})
							.catch(reject);
					});
				} else {
					reject();
				}
			})
			.catch(reject);
	});
}

export function prepareNostrEvent(args: {
	ndk: NDKSvelte;
	author: NDKUser;
	kind: NDKKind;
	content: string;
	tags?: NDKTag[];
}) {
	let e = new NDKEvent(args.ndk);
	e.author = args.author;
	e.kind = args.kind;
	e.created_at = Math.floor(new Date().getTime() / 1000);
	e.content = args.content;
	if (args.tags) {
		e.tags = args.tags;
	}
	console.log(e.rawEvent());
	return e;
}

export function drawSvgPath(qr: QrCode, border: number): string {
	if (border < 0) throw new RangeError('Border must be non-negative');
	let parts: Array<string> = [];
	for (let y = 0; y < qr.size; y++) {
		for (let x = 0; x < qr.size; x++) {
			if (qr.getModule(x, y)) parts.push(`M${x + border},${y + border}h1v1h-1z`);
		}
	}
	return parts.join(' ');
}
