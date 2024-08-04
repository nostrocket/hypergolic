<script lang="ts">
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Alert from '@/components/ui/alert';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button/index.js';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent, NDKZap } from '@nostr-dev-kit/ndk';
	import { Terminal } from 'lucide-svelte';
	import { requestProvider } from 'webln';
	import QrCodeSvg from './QrCodeSvg.svelte';
	import CopyButton from './CopyButton.svelte';
	import type { Product, Rocket, RocketProduct } from '@/event_helpers/rockets';

	export let product: Product;
	export let rocketProduct: RocketProduct | undefined;
	export let rocket: Rocket;

	let invoice: string | null;

	async function zap() {
		if (rocketProduct) {
			const z = new NDKZap({ ndk: $ndk, zappedEvent: rocket.Event, zappedUser: rocket.Event.author });
			invoice = await z.createZapRequest(
				rocketProduct.Price * 1000,
				`Purchase of ${product.Name()} from ${rocket.Event.dTag}`,
				[['product', product.ID()]]
			);
		}
	}

	async function payWithWebLn() {
		try {
			if (!invoice) {
				throw Error('invoice not found');
			}
			const webln = await requestProvider();
			const response = await webln.sendPayment(invoice);
			if (response && response.preimage) {
				console.log(response.preimage);
				open = false;
			}
		} catch (error) {
			console.error(error);
		}
	}
	let open: boolean;
</script>

{#if rocketProduct}
	<Dialog.Root bind:open>
		<Dialog.Trigger class={buttonVariants({ variant: 'default' })}
			>Buy Now for {rocketProduct.Price} sats</Dialog.Trigger
		>
		<Dialog.Content class="sm:max-w-[425px]">
			<Dialog.Header>
				<Dialog.Title
					>Buy {product.Name()} from {rocket.Name()} now!</Dialog.Title
				>
				{#if !currentUser}
					<Alert.Root>
						<Terminal class="h-4 w-4" />
						<Alert.Title>Heads up!</Alert.Title>
						<Alert.Description
							>You need a nostr signing extension to use Nostrocket!</Alert.Description
						>
					</Alert.Root>
				{/if}
				<Dialog.Description>Pay {rocketProduct.Price} sats now with Lightning</Dialog.Description>
			</Dialog.Header>
			{#if invoice}
				<QrCodeSvg content={invoice} />
				<div class="flex gap-2">
					<Input bind:value={invoice} readonly />
					<CopyButton text={invoice} />
				</div>
				<Button on:click={payWithWebLn}>Pay with WebLN</Button>
			{:else}
				<Button on:click={zap}>Create invoice</Button>
			{/if}
		</Dialog.Content>
	</Dialog.Root>
{/if}
