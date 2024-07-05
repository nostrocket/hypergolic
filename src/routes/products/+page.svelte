<script lang="ts">
	import { ndk } from "@/ndk";
	import type { NDKEvent } from "@nostr-dev-kit/ndk";
	import type { NDKEventStore } from "@nostr-dev-kit/ndk-svelte";
	import { onDestroy } from "svelte";

    let entries: NDKEventStore<NDKEvent> | undefined;
	onDestroy(() => {
		entries?.unsubscribe();
	});

	entries = $ndk.storeSubscribe([{ kinds: [1908 as number] }], { subId: 'products' });
</script>

{#if entries && $entries} 
{#each $entries as e}
<p>{e.tags}</p>
{/each}
{/if}