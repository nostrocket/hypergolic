<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { prepareMeritNoteEvent, type MeritRequest } from '@/event_helpers/merits';
	import { ndk } from '@/ndk';
	import { NDKKind } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { onDestroy } from 'svelte';

	import { Separator } from '$lib/components/ui/separator/index.js';
	import { unixToRelativeTime } from '@/helpers';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { currentUser } from '@/stores/session';
	import CornerDownLeft from 'lucide-svelte/icons/corner-down-left';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';

	export let merit: MeritRequest;

	let comments = $ndk.storeSubscribe({ kinds: [1 as NDKKind], '#e': [merit.ID] });

	onDestroy(() => {
		comments.unsubscribe();
	});

	let content: string;

	function publish(ndk: NDKSvelte) {
		if (!ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		const e = prepareMeritNoteEvent({
			ndk,
			merit,
			content
		});
		e.publish().then((x) => {
			console.log(x);
		});
	}
</script>

<div class="sm:col-span-1">
	<Card.Root>
		<Card.Header class="pb-3"><Card.Title>Discussion</Card.Title></Card.Header>
		<form class="relative overflow-hidden bg-background">
			<Label for="message" class="sr-only">Message</Label>
			<Textarea
				id="message"
				placeholder="Type your comment here..."
				class="w-full resize-none shadow-none"
				bind:value={content}
			/>
			<div class="flex items-center p-2">
				<Button
					type="submit"
					size="sm"
					class="ml-auto gap-1.5"
					on:click={() => {
						publish($ndk);
					}}
				>
					Publish
					<CornerDownLeft class="size-3.5" />
				</Button>
			</div>
		</form>
		<ol>
			{#each $comments as comment (comment.id)}
				<Separator />
				<li class="flex flex-col p-2">
					<div class="flex items-center gap-2">
						<Avatar
							ndk={$ndk}
							pubkey={comment.pubkey}
							class="h-5 w-5 flex-none rounded-full object-cover"
						/>
						<Name ndk={$ndk} pubkey={comment.pubkey} class="inline-block truncate" />
					</div>
					<div class="break-words">{comment.content}</div>
					<div>
						{comment.created_at ? unixToRelativeTime(comment.created_at * 1000) : 'Loading'}
					</div>
				</li>
			{/each}
		</ol>
	</Card.Root>
</div>
