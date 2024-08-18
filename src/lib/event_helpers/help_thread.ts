import { prepareNostrEvent } from '@/helpers';
import { NDKKind, type NDKEvent } from '@nostr-dev-kit/ndk';
import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';

export const HELP_THREAD_ROOT_EVENT_ID =
	'850941b4b8259aea64fef1e5083dd81af0d9bf1bcf3df6e370bdddbc6f819f4c';
const HELP_THREAD_ROOT_AUTHOR_PUBKEY =
	'd91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075';

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
			content: note.content.replace(
				'#nostrocket ping nostr:npub1mygerccwqpzyh9pvp6pv44rskv40zutkfs38t0hqhkvnwlhagp6s3psn5p',
				''
			),
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
		['e', HELP_THREAD_ROOT_EVENT_ID, 'wss://relay.nostrocket.org', 'mention']
	];
	args.content = `${args.content} #nostrocket ping nostr:npub1mygerccwqpzyh9pvp6pv44rskv40zutkfs38t0hqhkvnwlhagp6s3psn5p`;
	return prepareNostrEvent({
		...args,
		kind: NDKKind.Text,
		tags
	});
}
