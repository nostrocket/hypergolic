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

	let rockets = derived(_rockets, ($rockets)=>{
		let _r = new Map<string, Rocket>()
		for (let e of $rockets) {
			let existing = _r.get(`${e.pubkey}${e.dTag}`)
			if (!existing) {
				console.log(e)
				existing = new Rocket(e)
			}
			if (existing.Event.created_at <= e.created_at) {
				_r.set(`${e.pubkey}${e.dTag}`, existing)
			}
		}
		return Array.from(_r, ([_, r])=>{return r})
	})

	
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
