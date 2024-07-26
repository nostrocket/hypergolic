<script lang="ts">
	import type { NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import Heading from '../../components/Heading.svelte';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { onDestroy } from 'svelte';
	import { ndk } from '@/ndk';
	import Todo from '../../components/Todo.svelte';
	import RocketCard from '../../components/RocketCard.svelte';

	let entries: NDKEventStore<NDKEvent> | undefined;
	onDestroy(() => {
		entries?.unsubscribe();
	});

	entries = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'rockets' });
	//todo: until we have namerocket working, just manually dedupe rockets based on my pubkey
	//todo: write a recognizer/validator for rocket events
</script>

<Heading title="Rockets" />
{#if entries && $entries}
	<Todo text={['render these in a nicer way, maybe a grid or something']} />

	{#each $entries as rocketEvent (rocketEvent.id)}
		<RocketCard {rocketEvent} />
	{/each}
{/if}
