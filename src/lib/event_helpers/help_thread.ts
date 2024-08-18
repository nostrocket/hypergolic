import { prepareNostrEvent } from '@/helpers';
import { NDKKind, type NDKEvent } from '@nostr-dev-kit/ndk';
import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';

export const HELP_THREAD_ROOT_EVENT_ID =
	'f05059e5d33716c38a10b392538a592de91014b6e9610c91e5f50543f2fdb4fd';
const HELP_THREAD_ROOT_AUTHOR_PUBKEY =
	'887f827161338ef4d3e83482498664ad7454caf9bda7d080c3b32821f1394708';

export interface TreeNote {
	id: string;
	pubkey: string;
	content: string;
	created_at: number;
	reply?: string;
	root: string;
	children: TreeNote[];
}

export function buildNoteTree(notes: NDKEvent[]): TreeNote[] {
	const noteMap = new Map<string, TreeNote>();

	notes.forEach((note) => {
		const rootTag = note.getMatchingTags('e', 'root')[0]?.[1];
		const replyTag = note.getMatchingTags('e', 'reply')[0]?.[1];

		noteMap.set(note.id, {
			id: note.id,
			pubkey: note.author.pubkey,
			content: note.content,
			created_at: note.created_at!,
			root: rootTag,
			reply: replyTag,
			children: []
		});
	});

	notes.forEach((note) => {
		const replyTag = note.getMatchingTags('e', 'reply')[0]?.[1];
		if (replyTag) {
			const parent = noteMap.get(replyTag);
			const self = noteMap.get(note.id);
			if (parent && self) {
				parent.children.push(self);
			}
		}
	});

	const result = Array.from(noteMap.values()).filter(
		(note) =>
			!note.reply ||
			(note.reply === HELP_THREAD_ROOT_EVENT_ID && note.root === HELP_THREAD_ROOT_EVENT_ID)
	);

	return result;
}

export function prepareQuestionNoteEvent(args: { ndk: NDKSvelte; content: string }) {
	const tags = [
		['p', HELP_THREAD_ROOT_AUTHOR_PUBKEY],
		['e', HELP_THREAD_ROOT_EVENT_ID, 'wss://relay.nostrocket.org', 'reply'],
		['e', HELP_THREAD_ROOT_EVENT_ID, 'wss://relay.nostrocket.org', 'root']
	];
	return prepareNostrEvent({
		...args,
		kind: NDKKind.Text,
		tags
	});
}
