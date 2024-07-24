import type { NDKEvent } from '@nostr-dev-kit/ndk';

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
	try {
		if (isGitHubIssueUrl(problem)) {
			const apiURL = convertToGitHubApiUrl(problem);
			if (!apiURL) {
				return problem;
			}
			const response = await fetch(apiURL);
			const json = await response.json();
			return json.title;
		} else {
			return problem;
		}
	} catch (error) {
		console.error('Get title error:', error);
		return problem;
	}
}

function isGitHubIssueUrl(url: string): boolean {
	try {
		const parsedUrl: URL = new URL(url);
		if (parsedUrl.hostname !== 'github.com') {
			return false;
		}
		const pathParts: string[] = parsedUrl.pathname.split('/').filter((part) => part !== '');
		if (pathParts.length !== 4 || pathParts[2] !== 'issues' || !/^[1-9]\d*$/.test(pathParts[3])) {
			return false;
		}
		return true;
	} catch (error) {
		return false;
	}
}

function convertToGitHubApiUrl(issueUrl: URL | string): URL | null {
	try {
		const url = new URL(issueUrl);
		if (url.hostname !== 'github.com') {
			throw new Error('Not a valid GitHub URL');
		}
		const pathParts = url.pathname.split('/').filter((part) => part !== '');
		if (pathParts.length !== 4 || pathParts[2] !== 'issues') {
			throw new Error('Not a valid GitHub issue URL');
		}
		const [owner, repo, , issueNumber] = pathParts;
		return new URL(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`);
	} catch (error) {
		console.error('URL conversion error:', error);
		return null;
	}
}
