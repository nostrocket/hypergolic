<script lang="ts">
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { unixToRelativeTime } from '@/helpers';
	import { ndk } from '@/ndk';
	import type { TreeNote } from '@/event_helpers/help_thread';

	export let notes: TreeNote[];
	export let isRoot: boolean = false;
</script>

<ol class="w-full">
	{#each notes as note, index (note.id)}
		{#if isRoot && index > 0}
			<Separator />
		{/if}
		<li class="flex flex-col p-5">
			<div class="flex items-center gap-2">
				<Avatar
					ndk={$ndk}
					pubkey={note.pubkey}
					class="h-5 w-5 flex-none rounded-full object-cover"
				/>
				<Name ndk={$ndk} pubkey={note.pubkey} class="inline-block truncate" />
			</div>
			<div class="overflow-hidden break-words" style="overflow-wrap: anywhere;">{note.content}</div>
			<div class="text-gray-500">
				{note.created_at ? unixToRelativeTime(note.created_at * 1000) : 'Loading'}
			</div>
			{#if note.children.length > 0}
				<div class="ml-4">
					<svelte:self notes={note.children} isRoot={false} />
				</div>
			{/if}
		</li>
	{/each}
</ol>
