<script lang="ts">
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import Button from '@/components/ui/button/button.svelte';
	import * as Card from '@/components/ui/card';
	import { Rocket, ZapPurchase } from '@/event_helpers/rockets';
	import { devmode } from '@/stores/session';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import BitcoinAssociations from './AssociatedBitcoinAddresses.svelte';
	import MeritRequests from './MeritRequests.svelte';
	import MeritsAndSatflow from './MeritsAndSatflow.svelte';
	import ProductFomo from './ProductFomo.svelte';
	import ProposedProducts from './ProposedProducts.svelte';
	import UpdateMission from './UpdateMission.svelte';
	import UpgradeRocket from './UpgradeRocket.svelte';

	export let rocket: NDKEvent;

	$: unratifiedZaps = new Map<string, ZapPurchase>();
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
		<MeritsAndSatflow {unratifiedZaps} rocket={new Rocket(rocket)} />

		<ProductFomo bind:unratifiedZaps rocket={new Rocket(rocket)} />

		<ProposedProducts rocket={new Rocket(rocket)} />

		<MeritRequests rocket={new Rocket(rocket)} />
		<!-- <BitcoinAssociations rocket={new Rocket(rocket)} /> -->
		<Card.Root class="sm:col-span-3">
			<Card.Header class="pb-3">
				<Card.Title class="pb-4">Actions</Card.Title>
				<Card.Description class="flex flex-wrap gap-2">
					<UpdateMission rocketEvent={rocket} />
					<UpgradeRocket rocketEvent={rocket} />
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
