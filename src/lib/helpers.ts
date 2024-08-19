import { NDKKind, NDKZap, NDKEvent, NDKUser, type NDKTag } from '@nostr-dev-kit/ndk';
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

export function formatSats(sats: number): string {
	if (sats === 1) {
		return '1 sat';
	} else if (sats >= 1000) {
		const kSats = (sats / 1000).toFixed(0);
		return `${kSats}k sats`;
	} else {
		return `${sats} sats`;
	}
}

export async function getCuckPrice(): Promise<number> {
	return new Promise((resolve, reject) => {
		var url = 'https://api.coindesk.com/v1/bpi/currentprice.json';
		var symbol = 'USD';
		fetch(url)
			.then((r) => {
				r.json()
					.then((j) => {
						resolve(parseFloat(j.bpi[symbol].rate.replace(/,/g, '')));
					})
					.catch((e) => {
						reject(e as Error);
					});
			})
			.catch((e) => {
				reject(e as Error);
			});
	});
}

interface GitHubUrlParts {
	owner: string;
	repo: string;
	type?: 'issues' | 'pull';
	number?: string;
}

export class GitHubApiError extends Error {
	constructor(
		message: string,
		public status?: number
	) {
		super(message);
		this.name = 'GitHubApiError';
	}
}

export function parseGitHubUrl(url: URL): GitHubUrlParts {
	const parts = url.pathname.split('/').filter(Boolean);
	if (parts.length < 2) {
		throw new Error('Invalid GitHub URL');
	}
	return {
		owner: parts[0],
		repo: parts[1],
		type: parts[2] as 'issues' | 'pull' | undefined,
		number: parts[3]
	};
}

export async function parseProblem(problem: string): Promise<string | undefined> {
	if (!isGitHubIssuesOrPullUrl(problem)) {
		return undefined;
	}

	try {
		const { owner, repo, number } = parseGitHubUrl(new URL(problem));

		const apiURL = new URL(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`);
		const response = await fetch(apiURL);
		if (!response.ok) {
			throw new GitHubApiError(`HTTP error! status: ${response.status}`, response.status);
		}

		const json = await response.json();
		return json.title;
	} catch (error) {
		console.error('Failed to parse problem:', error);
		return undefined;
	}
}

export function isGitHubIssuesOrPullUrl(str: string): boolean {
	try {
		const url = new URL(str);
		const { owner, repo, type, number } = parseGitHubUrl(url);
		return (
			url.hostname === 'github.com' &&
			!!owner &&
			!!repo &&
			!!type &&
			!!number &&
			['issues', 'pull'].includes(type) &&
			/^[1-9]\d*$/.test(number)
		);
	} catch {
		return false;
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
							.catch((e) => reject(e));
					});
				} else {
					reject({
						reason: 'could not get zap endpoint for ' + z.zappedUser.pubkey,
						pubkey: z.zappedUser.pubkey
					});
				}
			})
			.catch((e) => reject(e));
	});
}

export function prepareNostrEvent(args: {
	ndk: NDKSvelte;
	kind: NDKKind;
	content: string;
	tags?: NDKTag[];
}) {
	let e = new NDKEvent(args.ndk);
	e.kind = args.kind;
	e.content = args.content;
	if (args.tags) {
		e.tags = args.tags;
	}
	console.log(e.rawEvent());
	return e;
}

export async function prepareEncryptedDirectMessageEvent(args: {
	ndk: NDKSvelte;
	receiver: NDKUser;
	content: string;
}) {
	const signer = args.ndk.signer;
	if (!signer) {
		return new Error('no signer');
	}
	const tags = [['p', args.receiver.pubkey]];
	const event = prepareNostrEvent({
		...args,
		kind: NDKKind.EncryptedDirectMessage,
		tags
	});
	await event.encrypt(args.receiver, signer);
	return event;
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

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
