<script lang="ts">
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import Button from '@/components/ui/button/button.svelte';
	import * as Card from '@/components/ui/card';
	import PurchaseToast from './PruchaseToast.svelte';
	import { Rocket, ZapPurchase } from '@/event_helpers/rockets';
	import { devmode } from '@/stores/session';
	import { toast } from 'svelte-sonner';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import BitcoinAssociations from './AssociatedBitcoinAddresses.svelte';
	import MeritRequests from './MeritRequests.svelte';
	import MeritsAndSatflow from './MeritsAndSatflow.svelte';
	import ProductFomo from './ProductFomo.svelte';
	import ProposedProducts from './ProposedProducts.svelte';
	import UpdateMission from './UpdateMission.svelte';
	import { onMount } from 'svelte';

	export let rocket: NDKEvent;

	$: unratifiedZaps = new Map<string, ZapPurchase>();
	let lastCheckTime = Date.now() / 1000; // Current time in seconds

	function checkNewZaps() {
		const currentTime = Date.now() / 1000;
		const recentZaps = Array.from(unratifiedZaps.values()).filter(
			(zap) =>
				zap.ZapReceipt.created_at &&
				zap.ZapReceipt.created_at > lastCheckTime &&
				zap.ZapReceipt.created_at <= currentTime
		);

		recentZaps.forEach((zapPurchase) => {
			toast(PurchaseToast, {
				componentProps: {
					zapPurchase,
					rocket: new Rocket(rocket)
				}
			});
		});

		lastCheckTime = currentTime;
	}
	$: {
		if (unratifiedZaps.size > 0) {
			checkNewZaps();
		}
	}
	onMount(() => {
		lastCheckTime = Date.now() / 1000 - 30; // 30 seconds ago
	});

	$: lasted = Array.from(unratifiedZaps.values()).sort((a, b) => {
		if (a.ZapReceipt.created_at && b.ZapReceipt.created_at) {
			return b.ZapReceipt.created_at - a.ZapReceipt.created_at;
		} else return 0;
	})[0];
</script>

<div class="flex flex-col gap-4">
	<header class="flex items-center">
		<Breadcrumb.Root class="flex">
			<Breadcrumb.List>
				<Breadcrumb.Item>
					<Breadcrumb.Link href="#">{rocket.getMatchingTags('d')[0][1]}</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator />
				<Breadcrumb.Item>
					<Breadcrumb.Page>Dashboard</Breadcrumb.Page>
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>
	</header>
	<main class="grid w-full flex-1 grid-cols-1 items-start gap-4 sm:grid-cols-3 md:gap-2">
		{#if $devmode}
			<Button
				on:click={() => {
					if (!lasted) {
						toast('unratifiedZaps is null');
					} else {
						console.log(lasted);
						toast(PurchaseToast, {
							componentProps: {
								zapPurchase: lasted,
								rocket: new Rocket(rocket)
							}
						});
					}
				}}
				variant="outline">Popup Last Purchase Notification</Button
			>
			<Button variant="outline" on:click={() => console.log(Array.from(unratifiedZaps.values()))}
				>print unratifiedZaps</Button
			>
		{/if}
		<MeritsAndSatflow {unratifiedZaps} rocket={new Rocket(rocket)} />

		<ProductFomo bind:unratifiedZaps rocket={new Rocket(rocket)} />

		<ProposedProducts rocket={new Rocket(rocket)} />

		<MeritRequests rocket={new Rocket(rocket)} />
		<BitcoinAssociations rocket={new Rocket(rocket)} />
		<Card.Root class="sm:col-span-3">
			<Card.Header class="pb-3">
				<Card.Title class="pb-4">Actions</Card.Title>
				<Card.Description class="flex flex-wrap gap-2">
					<UpdateMission rocketEvent={rocket} />
					{#if $devmode}
						<Button
							on:click={() => {
								console.log(rocket.rawEvent());
							}}>Print to Console</Button
						>{/if}
				</Card.Description>
			</Card.Header>
			<Card.Footer></Card.Footer>
		</Card.Root>
	</main>
</div>
