<script lang="ts">
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { ndk } from '@/ndk';
	import { unixToRelativeTime } from '@/helpers';
	import { fetchEvent } from '@/event_helpers/products';
	import { Product, Rocket, type ZapPurchase } from '@/event_helpers/rockets';

	export let zapPurchase: ZapPurchase;
	export let rocket: Rocket;
</script>

<div class="flex flex-col gap-1">
	{#if zapPurchase.ZapReceipt.content}
		<div>{zapPurchase.ZapReceipt.content}</div>
	{:else}
		<!-- Sometimes ZapReceipt.content is empty -->
		{#await fetchEvent(zapPurchase.ProductID, $ndk)}
			<div>New purchase</div>
		{:then product}
			<div>{`Purchase of ${new Product(product).Name()} from ${rocket.Name()}.`}</div>
		{/await}
	{/if}
	{#if zapPurchase.BuyerPubkey}
		<div class="flex flex-nowrap gap-1">
			<Avatar
				ndk={$ndk}
				pubkey={zapPurchase.BuyerPubkey}
				class="h-10 w-10 flex-none rounded-full object-cover"
			/>
			<Name
				ndk={$ndk}
				pubkey={zapPurchase.BuyerPubkey}
				class="hidden max-w-32 truncate p-2 md:inline-block"
			/>
		</div>
	{/if}
	{#if zapPurchase.Amount}
		<div>
			Amount: {(zapPurchase.Amount / 1000).toFixed(0)}
			{(zapPurchase.Amount / 1000).toFixed(0) === '1' ? 'sat' : 'sats'}
		</div>
	{/if}
	{#if zapPurchase.ZapReceipt.created_at}
		<div>
			{unixToRelativeTime(zapPurchase.ZapReceipt.created_at * 1000)}
		</div>
	{/if}
</div>
