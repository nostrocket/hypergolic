<script lang="ts">
	import { Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import Heading from '../../components/Heading.svelte';
	import RocketCard from '../../components/RocketCard.svelte';
	import ExclamationTriangle from 'svelte-radix/ExclamationTriangle.svelte';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import AssociateBitcoinAddress from '../../stateupdaters/AssociateBitcoinAddress.svelte';

	let _rockets = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'rockets' });
	onDestroy(() => {
		_rockets?.unsubscribe();
	});

	let rockets = derived(_rockets, ($rockets) => {
		let _r = new Map<string, Rocket>();
		for (let e of $rockets) {
			let existing = _r.get(`${e.pubkey}${e.dTag}`);
			if (!existing) {
				existing = new Rocket(e);
			}
			const existingCreatedAt = existing.Event?.created_at ?? 0;
			const newCreatedAt = e.created_at ?? 0;
			if (existingCreatedAt <= newCreatedAt) {
				_r.set(`${e.pubkey}${e.dTag}`, existing);
			}
		}
		let rocketArray = Array.from(_r.values());
		rocketArray.sort((a, b) => sortRockets(a, b));
		return rocketArray;
	});

	function sortRockets(a: Rocket, b: Rocket): number {
		// First condition: "Nostrocket" at the top
		if (a.Name() === 'Nostrocket') return 1;
		if (b.Name() === 'Nostrocket') return -1;
		// Second condition: "test" rockets grouped underneath
		const aIsTest = a.Name().toLowerCase().includes('test');
		const bIsTest = b.Name().toLowerCase().includes('test');
		if (aIsTest && !bIsTest) return -1;
		if (!aIsTest && bIsTest) return 1;
		// Default sorting by created_at, handling undefined
		const aCreatedAt = a.Event?.created_at ?? 0;
		const bCreatedAt = b.Event?.created_at ?? 0;
		return bCreatedAt - aCreatedAt;
	}

	function splitRockets(rocketArray: Rocket[]): { mainnet: Rocket[]; testnet: Rocket[] } {
		let mainnet: Rocket[] = [];
		let testnet: Rocket[] = [];
		for (let rocket of rocketArray) {
			if (rocket.Name().toLowerCase().includes('test')) {
				testnet.push(rocket);
			} else {
				mainnet.push(rocket);
			}
		}
		return { mainnet, testnet };
	}

	let rocketStore = derived(rockets, (rocketArray) => splitRockets(rocketArray));
	let mainnet: Rocket[] = [];
	let testnet: Rocket[] = [];

	rocketStore.subscribe(($rocketStore) => {
		mainnet = $rocketStore.mainnet;
		testnet = $rocketStore.testnet;
	});
</script>

<Heading title="Rockets" />
{#if rockets && $rockets}
	<AssociateBitcoinAddress {rockets} />
	<Tabs.Root value="mainnet">
		<Tabs.List>
			<Tabs.Trigger value="mainnet">Mainnet</Tabs.Trigger>
			<Tabs.Trigger value="testnet">Testnet</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="mainnet">
			<div class="grid gap-2" style="grid-template-columns: repeat(auto-fit, 350px);">
				{#each mainnet as rocket (`${rocket.Event.pubkey}${rocket.Name()}`)}
					<RocketCard {rocket} />
				{/each}
			</div>
		</Tabs.Content>
		<Tabs.Content value="testnet">
			<Alert.Root class="my-2">
				<ExclamationTriangle class="h-4 w-4" />
				<Alert.Title>Note</Alert.Title>
				<Alert.Description
					>The following rocket is for testing purposes only. Any rocket with "test" in its name is
					intended solely for testing.</Alert.Description
				>
			</Alert.Root>
			<div class="grid gap-2" style="grid-template-columns: repeat(auto-fit, 350px);">
				{#each testnet as rocket (`${rocket.Event.pubkey}${rocket.Name()}`)}
					<RocketCard {rocket} />
				{/each}
			</div>
		</Tabs.Content>
	</Tabs.Root>
{/if}
