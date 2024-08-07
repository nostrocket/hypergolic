<script lang="ts">
	import { Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import Heading from '../../components/Heading.svelte';
	import RocketCard from '../../components/RocketCard.svelte';
	import Todo from '../../components/Todo.svelte';
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

		rocketArray.sort((a, b) => {
			// First condition: "Nostrocket" at the top
			if (a.Name() === 'Nostrocket') return -1;
			if (b.Name() === 'Nostrocket') return 1;

			// Second condition: "test" rockets grouped underneath
			const aIsTest = a.Name().toLowerCase().includes('test');
			const bIsTest = b.Name().toLowerCase().includes('test');
			if (aIsTest && !bIsTest) return 1;
			if (!aIsTest && bIsTest) return -1;

			// Default sorting by created_at, handling undefined
			const aCreatedAt = a.Event?.created_at ?? 0;
			const bCreatedAt = b.Event?.created_at ?? 0;
			return aCreatedAt - bCreatedAt;
		});

		return rocketArray;
	});

	//todo: until we have namerocket working, just manually dedupe rockets based on my pubkey
	//todo: write a recognizer/validator for rocket events
</script>

<Heading title="Rockets" />
{#if rockets && $rockets}
	<AssociateBitcoinAddress {rockets} />
	<Todo text={['render these in a nicer way, maybe a grid or something']} />

	{#each $rockets as rocket (`${rocket.Event.pubkey}${rocket.Name()}`)}
		<RocketCard {rocket} />
	{/each}
{/if}
