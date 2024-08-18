<script lang="ts">
	import { fetchEvent } from '@/event_helpers/products';
	import { Product, Rocket, type ZapPurchase } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';

	export let zapPurchase: ZapPurchase;
	export let rocket: Rocket;
</script>

<div class="flex flex-col gap-1 rounded-md bg-orange-500 p-4 text-white dark:text-black">
	<div class="">
		{#if zapPurchase.ZapReceipt.content}
			<h1 class="scroll-m-20 text-center text-lg font-normal md:text-xl">
				NEW {zapPurchase.ZapReceipt.content.toUpperCase()}!
			</h1>
		{:else}
			<!-- Sometimes ZapReceipt.content is empty -->
			{#await fetchEvent(zapPurchase.ProductID, $ndk)}
				<div>New purchase!</div>
			{:then product}
				<div>{`Purchase of ${new Product(product).Name()} from ${rocket.Name()}.`}</div>
			{/await}
		{/if}
	</div>
	{#if zapPurchase.BuyerPubkey}
		<div class="ml-auto mr-auto mt-4 flex content-center items-center">
			{#if zapPurchase.Amount}
				<div class="flex-col content-center items-center gap-1">
					<h1 class="scroll-m-20 text-center font-mono text-3xl">
						{Math.floor(zapPurchase.Amount / 1000).toLocaleString()}
					</h1>
					<span class="flex">Sats paid to Merit holders</span>
				</div>
			{/if}
			<div
				class="ml-4 flex flex-col content-center items-center gap-1 rounded-sm bg-black p-2 text-white"
			>
				BUYER
				<Avatar
					ndk={$ndk}
					pubkey={zapPurchase.BuyerPubkey}
					class="h-20 w-20 flex-none rounded-none object-cover"
				/>
				<Name
					ndk={$ndk}
					pubkey={zapPurchase.BuyerPubkey}
					class="hidden max-w-32 truncate p-2 md:inline-block"
				/>
			</div>
		</div>
	{/if}
</div>
