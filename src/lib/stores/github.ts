import { GitHubApiError, parseGitHubUrl } from '@/helpers';
import { writable } from 'svelte/store';

interface CommitInfo {
	count: number;
	hash: string;
}

let _c: CommitInfo = { hash: '', count: 0 };
export const commitInfo = writable(_c);

export async function getCommitInfo(url: URL): Promise<CommitInfo> {
	try {
		const { owner, repo } = parseGitHubUrl(url);
		const apiURL = new URL(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`);

		const response = await fetch(apiURL);
		if (!response.ok) {
			throw new GitHubApiError(`HTTP error! status: ${response.status}`, response.status);
		}
		const json = await response.json();

		if (!json[0]?.sha) {
			throw new GitHubApiError('Failed to fetch commit info: API returned unexpected data');
		}
		const totalCommits = parseLinkHeader(response.headers.get('Link'));

		let r: CommitInfo = {
			count: totalCommits,
			hash: json[0].sha
		};
		commitInfo.set(r);
		return r;
	} catch (error) {
		if (error instanceof GitHubApiError) {
			throw error;
		}
		throw new Error(
			`Failed to fetch commit info: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

function parseLinkHeader(header: string | null): number {
	if (!header) return 0;
	const matches = header.match(/page=(\d+)>; rel="last"/);
	return matches ? parseInt(matches[1], 10) : 0;
}
