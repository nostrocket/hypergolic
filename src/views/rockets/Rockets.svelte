<script lang="ts">
	import type { NDKEventStore } from '@nostr-dev-kit/ndk-svelte';
	import Heading from '../../components/Heading.svelte';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { onDestroy } from 'svelte';
	import { ndk } from '@/ndk';
	//flow: fetch all 31108's. For now, just validate that the author is the same as the ignition author. If naming conflicts, look for namerocket listing.

	let entries: NDKEventStore<NDKEvent> | undefined;
	onDestroy(() => {
		entries?.unsubscribe();
	});

	entries = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'rockets' });


</script>

<Heading title="Rockets" />
{#if entries && $entries} 
{#each $entries as e} <div on:click={()=>{console.log(e.rawEvent())}}>{e.tags}</div> <br /> {/each}
{/if}
<div
	class="max-w-sm rounded-lg border border-gray-200 bg-white shadow dark:border-gray-700 dark:bg-gray-800"
>
	<a href="#">
		<img
			class="rounded-t-lg"
			src="https://assets.editorial.aetnd.com/uploads/2009/11/joseph-stalin-gettyimages-464426375.jpg"
			alt=""
		/>
	</a>
	<div class="p-5">
		<a href="#">
			<h5 class="mb-2 text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
				The People's Rocket
			</h5>
		</a>
		<p class="mb-3 font-normal text-gray-700 dark:text-gray-400">
			Dedicated to delivering excellence through central planning.
		</p>
		<p class="mb-3 font-normal text-gray-700 dark:text-gray-400">Created by PabloF7z</p>
		<a
			href="#"
			class="inline-flex items-center rounded-lg bg-blue-700 px-3 py-2 text-center text-sm font-medium text-white hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-300 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800"
		>
			Read more
			<svg
				class="ms-2 h-3.5 w-3.5 rtl:rotate-180"
				aria-hidden="true"
				xmlns="http://www.w3.org/2000/svg"
				fill="none"
				viewBox="0 0 14 10"
			>
				<path
					stroke="currentColor"
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M1 5h12m0 0L9 1m4 4L9 9"
				/>
			</svg>
		</a>
	</div>
</div>
