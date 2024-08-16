<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input';
	import * as Alert from '@/components/ui/alert';
	import type { Product, Rocket, RocketProduct } from '@/event_helpers/rockets';
	import { formatSats } from '@/helpers';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKZap } from '@nostr-dev-kit/ndk';
	import { Spinner } from 'flowbite-svelte';
	import { CheckCircleOutline } from 'flowbite-svelte-icons';
	import { Terminal } from 'lucide-svelte';
	import { cubicOut } from 'svelte/easing';
	import { tweened } from 'svelte/motion';
	import { requestProvider } from 'webln';
	import CopyButton from './CopyButton.svelte';
	import QrCodeSvg from './QrCodeSvg.svelte';

	export let product: Product;
	export let rocketProduct: RocketProduct | undefined;
	export let rocket: Rocket;
	export let disabled = false;

	let invoice: string | null;
	let paymentInitiated: boolean;
	let paymentFinished: boolean;

	const scale = tweened(0, { duration: 1000, easing: cubicOut });

	async function zap() {
		if (rocketProduct) {
			const z = new NDKZap({
				ndk: $ndk,
				zappedEvent: rocket.Event,
				zappedUser: rocket.Event.author
			});
			invoice = await z.createZapRequest(
				rocketProduct.Price() * 1000,
				`Purchase of ${product.Name()} from ${rocket.Event.dTag}`,
				[['product', product.ID()]]
			);
		}
	}

	async function payWithWebLn() {
		paymentInitiated = true;

		try {
			if (!invoice) {
				throw Error('invoice not found');
			}
			const webln = await requestProvider();
			const response = await webln.sendPayment(invoice);
			if (response && response.preimage) {
				console.log(response.preimage);
				paymentFinished = true;

				await scale.set(1);
				await new Promise((resolve) => setTimeout(resolve, 1000)); // allow 1 second before resetting payment/dialog states

				open = false;
				paymentFinished = false;

				await scale.set(0);
			}
		} catch (error) {
			console.error(error);
		} finally {
			paymentInitiated = false;
		}
	}

	let previousProduct: Product;
	$: if (product !== previousProduct) {
		invoice = null;
		previousProduct = product;
	}

	let open: boolean;
</script>

{#if rocketProduct}
	<Dialog.Root bind:open>
		<Dialog.Trigger>
			<Button {disabled}>
				{#if open}
					<Spinner class="me-2" color="white" size={4} /> Confirming...
				{:else if !disabled}
					Buy Now for {formatSats(rocketProduct.Price())}
				{:else if disabled}
					Out of Stock!
				{/if}
			</Button>
		</Dialog.Trigger>

		<Dialog.Content class="sm:max-w-[425px]">
			<Dialog.Header>
				<Dialog.Title>Buy {product.Name()} from {rocket.Name()} now!</Dialog.Title>
				{#if !currentUser}
					<Alert.Root>
						<Terminal class="h-4 w-4" />
						<Alert.Title>Heads up!</Alert.Title>
						<Alert.Description
							>You need a nostr signing extension to use Nostrocket!</Alert.Description
						>
					</Alert.Root>
				{/if}
				<Dialog.Description
					>Pay {rocketProduct.Price() === 1
						? `${rocketProduct.Price()} sat`
						: `${rocketProduct.Price()} sats`} now with Lightning</Dialog.Description
				>
			</Dialog.Header>
			{#if invoice}
				<QrCodeSvg content={invoice} />
				<div class="flex gap-2">
					<Input bind:value={invoice} readonly />
					<CopyButton text={invoice} />
				</div>
				<Button on:click={payWithWebLn}>
					{#if paymentFinished}
						<div style="transform: scale({$scale});">
							<CheckCircleOutline class="me-2 text-white" color="white" />
						</div>
					{:else if paymentInitiated}
						<Spinner class="me-2" color="white" size={4} /> Confirming payment...
					{:else}
						Pay with WebLN
					{/if}
				</Button>
			{:else}
				<Button on:click={zap}>Create invoice</Button>
			{/if}
		</Dialog.Content>
	</Dialog.Root>
{/if}
