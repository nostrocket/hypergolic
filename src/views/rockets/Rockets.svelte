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
		return Array.from(_r.values());
	});

	function splitAndSortRockets(rocketArray: Rocket[]): { mainnet: Rocket[]; testnet: Rocket[] } {
		let mainnet: Rocket[] = [];
		let testnet: Rocket[] = [];

		for (let rocket of rocketArray) {
			if (rocket.Name().toLowerCase().includes('test')) {
				testnet.push(rocket);
			} else {
				mainnet.push(rocket);
			}
		}

		testnet.sort((a, b) => (b.Event?.created_at ?? 0) - (a.Event?.created_at ?? 0));

		mainnet.sort((a, b) => {
			if (a.Name() === 'NOSTROCKET') return -1;
			if (b.Name() === 'NOSTROCKET') return 1;
			return (b.Event?.created_at ?? 0) - (a.Event?.created_at ?? 0);
		});

		return { mainnet, testnet };
	}

	let rocketStore = derived(rockets, (rocketArray) => splitAndSortRockets(rocketArray));

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
			<div class="grid grid-cols-1 gap-2 md:grid-cols-2 2xl:grid-cols-3 3xl:grid-cols-4">
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
			<div class="grid grid-cols-1 gap-2 md:grid-cols-2 2xl:grid-cols-3 3xl:grid-cols-4">
				{#each testnet as rocket (`${rocket.Event.pubkey}${rocket.Name()}`)}
					<RocketCard {rocket} />
				{/each}
			</div>
		</Tabs.Content>
	</Tabs.Root>
{/if}
